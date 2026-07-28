/**
 * Subagents — spawn background subagents on Pi, Claude Code, Codex, or
 * read-only Cursor Agent, unified behind a single Effect service interface.
 *
 * Tools (for the parent LLM):
 * - subagent_spawn: fire-and-forget spawn (prompt, title, agent, working_dir,
 *   model, reasoning_effort). Max 4 running at once across all backends.
 * - subagent_wait: block until the listed subagents settle, return results.
 * - subagent_cancel: stop one or more running subagents.
 * - subagent_check: peek at a subagent's status and recent activity.
 * - subagent_list: list all subagents.
 *
 * Unawaited subagents queue their result as a follow-up message when they
 * settle. `/subagents` or Alt+S opens a modal picker + interactive takeover view.
 *
 * Architecture: Effect v4 generators throughout (backends -> manager ->
 * runtime); this file is the async boundary where tool handlers run effects
 * against one shared ManagedRuntime. All four backends are real: pi runs
 * in-process SDK sessions, claude drives the Claude Agent SDK, codex speaks
 * JSON-RPC to `codex app-server`, and cursor consumes Cursor Agent NDJSON.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  getAgentDir,
  getMarkdownTheme,
  ProjectTrustStore,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  SUBAGENT_INFO_CHANNEL,
  type SubagentInfoState,
} from "../shared/dashboard-state.ts";
import {
  buildBtwParentHandoff,
  buildBtwWorkerContract,
  deriveBtwTitle,
  isModelVisible,
} from "./src/by-the-way.ts";
import {
  loadSubagentConfig,
  resolveSpawnConfig,
} from "./src/config.ts";
import {
  BACKEND_NAMES,
  formatElapsed,
  latestText,
  REASONING_EFFORTS,
  SUBAGENT_PROFILES,
  type BackendName,
  type SubagentSnapshot,
} from "./src/domain.ts";
import {
  formatActivityStatus,
  formatContextUtilization,
} from "./src/format.ts";
import { registerSubagentHost } from "./src/host-bridge.ts";
import { SubagentManager, type SubagentManagerShape } from "./src/manager.ts";
import {
  buildSubagentResultMessage,
  buildSubagentSpawnResult,
  SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CANCEL_TOOL_DESCRIPTION,
  SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CHECK_TOOL_DESCRIPTION,
  SUBAGENT_LIST_TOOL_DESCRIPTION,
  SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SPAWN_PROMPT_GUIDELINES,
  SUBAGENT_SPAWN_PROMPT_SNIPPET,
  SUBAGENT_SPAWN_TOOL_DESCRIPTION,
  SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS,
  SUBAGENT_WAIT_TOOL_DESCRIPTION,
} from "./src/prompt.ts";
import { createDeferredResultDelivery } from "./src/result-delivery.ts";
import {
  assertCwdAllowed,
  confirmUnrestrictedSpawn,
  normalizeProfile,
} from "./src/safety.ts";
import {
  createSubagentRuntime,
  runTool,
  type SubagentRuntime,
} from "./src/runtime.ts";
import {
  openSubagentPicker,
  openSubagentSettings,
  openSubagentTakeover,
  type TakeoverAction,
} from "./src/ui/takeover.ts";

const SUBAGENT_OUTPUT_MAX_BYTES = 24 * 1024;
const WAIT_OUTPUT_MAX_BYTES = 48 * 1024;
const WAIT_PER_AGENT_MAX_BYTES = 16 * 1024;

interface BtwResultData {
  readonly id: string;
  readonly title: string;
  readonly status: SubagentSnapshot["status"];
  readonly errorText?: string;
  readonly prompt: string;
  readonly answer: string;
  readonly sessionFilePath?: string;
}

function describeSubagent(snap: SubagentSnapshot) {
  const details = [
    `${snap.backend}/${snap.profile}: ${snap.meta.modelLabel ?? "?"}`,
    formatContextUtilization(snap.usage),
    formatElapsed(snap),
    snap.cwd,
  ].filter(Boolean);
  return `${snap.id} [${snap.status}] "${snap.title}" (${details.join(", ")})`;
}

function truncatedOutput(
  snap: SubagentSnapshot,
  maxBytes = SUBAGENT_OUTPUT_MAX_BYTES,
): string {
  const output = snap.finalText || "(no output)";
  const truncation = truncateHead(output, {
    maxBytes: Math.min(maxBytes, DEFAULT_MAX_BYTES),
    maxLines: Math.min(600, DEFAULT_MAX_LINES),
  });
  let text = truncation.content;
  if (truncation.truncated) {
    text += `\n\n[Output truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)} shown. Full transcript in session file: ${snap.meta.sessionFilePath ?? "?"}]`;
  }
  return text;
}

/**
 * Same-directory children inherit the live parent decision. An alternate cwd
 * is trusted only when pi's persisted trust store explicitly trusts it (or a
 * containing directory); unreadable/invalid trust data fails closed.
 */
function resolveChildProjectTrust(options: {
  parentCwd: string;
  childCwd: string;
  parentTrusted: boolean;
}) {
  if (path.resolve(options.childCwd) === path.resolve(options.parentCwd)) {
    return options.parentTrusted;
  }
  try {
    const trustStore = new ProjectTrustStore(getAgentDir());
    return trustStore.get(options.childCwd) === true;
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  let runtime: SubagentRuntime | undefined;
  let managerPromise: Promise<SubagentManagerShape> | undefined;
  let sessionContext: ExtensionContext | undefined;
  let ui: ExtensionUIContext | undefined;
  let unsubStatus: (() => void) | undefined;
  const resultDelivery = createDeferredResultDelivery<SubagentSnapshot>();

  const getRuntime = () => (runtime ??= createSubagentRuntime());

  /** Resolve the manager service once per runtime and wire the extension hooks. */
  const getManager = () => {
    managerPromise ??= getRuntime()
      .runPromise(SubagentManager)
      .then((manager) => {
        manager.view.setOnSettled(onSettled);
        unsubStatus?.();
        unsubStatus = manager.view.subscribe(() => updateStatus(manager));
        updateStatus(manager);
        return manager;
      });
    return managerPromise;
  };

  const updateStatus = (manager: SubagentManagerShape) => {
    const subs = manager.view.list();
    const costState = {
      count: subs.length,
      costUsd: subs.reduce((total, snap) => total + (snap.usage.costUsd ?? 0), 0),
      costKnown: subs.every((snap) => snap.usage.costKnown),
    } satisfies SubagentInfoState;
    pi.events.emit(SUBAGENT_INFO_CHANNEL, costState);
    if (!ui) return;
    if (subs.length === 0) {
      ui.setStatus("subagents", undefined);
      return;
    }
    const running = subs.filter((snap) => snap.status === "running").length;
    const failed = subs.filter((snap) => snap.status === "error").length;
    const done = subs.length - running - failed;
    ui.setStatus(
      "subagents",
      formatActivityStatus(ui.theme, { running, done, failed }),
    );
  };

  const deliverResult = (snap: SubagentSnapshot) => {
    pi.sendMessage(
      {
        customType: "subagent-result",
        content: buildSubagentResultMessage({
          id: snap.id,
          title: snap.title,
          status: snap.status,
          errorText: snap.errorText,
          output: truncatedOutput(snap),
        }),
        display: true,
        details: { id: snap.id, title: snap.title, status: snap.status },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };

  const flushResults = () => {
    for (const snap of resultDelivery.drain()) deliverResult(snap);
  };

  const deliverBtwResult = (snap: SubagentSnapshot) => {
    // appendEntry is a synchronous SessionManager operation and emits an
    // entry_appended event, so it is safe while the parent is streaming and
    // never enters the model's context or follow-up queue.
    pi.appendEntry<BtwResultData>("btw-result", {
      id: snap.id,
      title: snap.title,
      status: snap.status,
      errorText: snap.errorText,
      prompt: snap.prompt,
      answer: truncatedOutput(snap),
      sessionFilePath: snap.meta.sessionFilePath,
    });
    ui?.notify(
      snap.status === "error"
        ? `by the way “${snap.title}” failed — reopen it with /subagents`
        : `by the way “${snap.title}” answered — reopen it with /subagents`,
      snap.status === "error" ? "error" : "info",
    );
  };

  const onSettled = (snap: SubagentSnapshot, consumed: boolean) => {
    // A shutdown can settle children while disposing their scopes. Never
    // append into a session whose extension runtime is already closing.
    if (!sessionContext) return;
    if (snap.origin === "btw") {
      deliverBtwResult({ ...snap, meta: { ...snap.meta } });
      return;
    }
    if (snap.origin === "wayfinder") {
      ui?.notify(
        snap.status === "error"
          ? `Wayfinder agent “${snap.title}” failed`
          : `Wayfinder agent “${snap.title}” is ready for review`,
        snap.status === "error" ? "error" : "info",
      );
      return;
    }
    if (consumed) {
      resultDelivery.consume([snap.id]);
      return;
    }
    // Keep the result retractable while the parent is working. A later
    // subagent_wait can consume it before agent_settled flushes follow-ups.
    // Defer a copy: the live snapshot keeps mutating if the subagent is
    // restarted before the deferred result flushes.
    resultDelivery.defer({ ...snap, meta: { ...snap.meta } });
    if (sessionContext?.isIdle()) flushResults();
  };

  pi.on("session_start", (_event, ctx) => {
    sessionContext = ctx;
    if (ctx.hasUI) ui = ctx.ui;
  });

  pi.on("agent_settled", flushResults);

  registerSubagentHost({
    list: async () => (await getManager()).view.list(),
    subscribe: async (listener) => (await getManager()).view.subscribe(listener),
    spawn: async (ctx, request) => {
      const cwd = path.resolve(request.cwd);
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        throw new Error(`Wayfinder agent working directory is invalid: ${cwd}`);
      }
      const manager = await getManager();
      const configured = resolveSpawnConfig(await loadSubagentConfig(), {
        harness: request.backend,
        model:
          request.model === "inherit" || request.model === "default"
            ? undefined
            : request.model,
        reasoningEffort: request.reasoningEffort,
        profile: request.profile,
      });
      const profile = normalizeProfile(configured.profile);
      assertCwdAllowed(ctx.cwd, cwd, profile);
      if (
        configured.harness === "cursor" &&
        (profile === "worker" || profile === "unrestricted")
      ) {
        throw new Error(
          "Cursor subagents currently support only scout and researcher profiles; unattended editing remains disabled.",
        );
      }
      return runTool(
        getRuntime(),
        manager.spawn(configured.harness, {
          origin: "wayfinder",
          prompt: request.prompt,
          title: request.title,
          cwd,
          model: configured.model,
          reasoningEffort: configured.reasoningEffort,
          profile,
          parent: {
            parentCwd: ctx.cwd,
            projectTrusted: resolveChildProjectTrust({
              parentCwd: ctx.cwd,
              childCwd: cwd,
              parentTrusted: ctx.isProjectTrusted(),
            }),
            inheritedModel: ctx.model
              ? { provider: ctx.model.provider, id: ctx.model.id }
              : undefined,
            inheritedThinkingLevel: pi.getThinkingLevel(),
            modelRegistry: ctx.modelRegistry,
          },
        }),
      );
    },
    takeover: async (ctx, id) => {
      const manager = await getManager();
      await openSubagentTakeover(ctx, manager.view, id, { badge: "Wayfinder" });
    },
    abort: async (id) => {
      const manager = await getManager();
      manager.view.requestAbort(id);
    },
  });

  pi.on("session_shutdown", async () => {
    sessionContext = undefined;
    registerSubagentHost(undefined);
    resultDelivery.clear();
    unsubStatus?.();
    unsubStatus = undefined;
    ui?.setStatus("subagents", undefined);
    pi.events.emit(SUBAGENT_INFO_CHANNEL, {
      count: 0,
      costUsd: 0,
      costKnown: true,
    } satisfies SubagentInfoState);
    ui = undefined;
    const closing = runtime;
    runtime = undefined;
    managerPromise = undefined;
    // Disposing the runtime runs the manager finalizer, which tears down all
    // subagent scopes (and, later, their real child processes).
    await closing?.dispose();
  });

  // --- Tools -------------------------------------------------------------

  pi.registerTool({
    name: "subagent_spawn",
    label: "Spawn Subagent",
    description: SUBAGENT_SPAWN_TOOL_DESCRIPTION,
    promptSnippet: SUBAGENT_SPAWN_PROMPT_SNIPPET,
    promptGuidelines: SUBAGENT_SPAWN_PROMPT_GUIDELINES,
    parameters: Type.Object({
      prompt: Type.String({
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.prompt,
      }),
      name: Type.String({
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.name,
      }),
      harness: Type.Optional(
        StringEnum(BACKEND_NAMES, {
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.harness,
        }),
      ),
      preset: Type.Optional(
        Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.preset,
        }),
      ),
      working_dir: Type.Optional(
        Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.workingDir,
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.model,
        }),
      ),
      reasoning_effort: Type.Optional(
        StringEnum(REASONING_EFFORTS, {
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.reasoningEffort,
        }),
      ),
      profile: Type.Optional(
        StringEnum(SUBAGENT_PROFILES, {
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.profile,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const manager = await getManager();
      const configured = resolveSpawnConfig(await loadSubagentConfig(), {
        harness: params.harness,
        preset: params.preset,
        model: params.model,
        reasoningEffort: params.reasoning_effort,
        profile: params.profile,
      });
      const harness = configured.harness;

      const cwd = path.resolve(ctx.cwd, params.working_dir ?? ".");
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        throw new Error(`working_dir is not a directory: ${cwd}`);
      }

      const title = params.name.trim().slice(0, 160) || "subagent";
      const profile = normalizeProfile(configured.profile);
      assertCwdAllowed(ctx.cwd, cwd, profile);
      if (
        harness === "cursor" &&
        (profile === "worker" || profile === "unrestricted")
      ) {
        throw new Error(
          "Cursor subagents currently support only scout and researcher profiles; unattended editing remains disabled.",
        );
      }
      if (profile === "unrestricted") {
        await confirmUnrestrictedSpawn(ctx, { harness, cwd, title });
      }
      const snap = await runTool(
        getRuntime(),
        manager.spawn(harness, {
          prompt: params.prompt,
          title,
          cwd,
          model: configured.model,
          reasoningEffort: configured.reasoningEffort,
          profile,
          parent: {
            parentCwd: ctx.cwd,
            projectTrusted: resolveChildProjectTrust({
              parentCwd: ctx.cwd,
              childCwd: cwd,
              parentTrusted: ctx.isProjectTrusted(),
            }),
            inheritedModel: ctx.model
              ? { provider: ctx.model.provider, id: ctx.model.id }
              : undefined,
            inheritedThinkingLevel: pi.getThinkingLevel(),
            modelRegistry: ctx.modelRegistry,
          },
        }),
        { signal, interruptMessage: "Subagent spawn aborted." },
      );

      return {
        content: [
          {
            type: "text",
            text: buildSubagentSpawnResult({
              id: snap.id,
              title: snap.title,
              harness,
              modelLabel: snap.meta.modelLabel ?? "?",
              cwd,
              profile,
              preset: configured.preset,
            }),
          },
        ],
        details: {
          id: snap.id,
          title: snap.title,
          cwd,
          harness,
          model: snap.meta.modelLabel,
          profile: snap.profile,
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for Subagents",
    description: SUBAGENT_WAIT_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        maxItems: 64,
        description: SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS.ids,
      }),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const manager = await getManager();
      const ids = [...new Set(params.ids)];
      if (ids.length === 0)
        throw new Error("Provide at least one subagent id.");
      const known = manager.view
        .list()
        .filter(isModelVisible)
        .map((snap) => snap.id);
      const unknown = ids.filter((id) => {
        const snap = manager.view.get(id);
        return !snap || !isModelVisible(snap);
      });
      if (unknown.length > 0) {
        throw new Error(
          `Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      await runTool(
        getRuntime(),
        manager.waitFor(ids, (pending) => {
          onUpdate?.({
            content: [
              { type: "text", text: `Waiting for ${pending.join(", ")}...` },
            ],
            details: { pending },
          });
        }),
        { signal, interruptMessage: "Wait aborted. Subagents keep running." },
      );

      // Settlement may have happened before this wait began. Remove any
      // deferred automatic delivery now that the tool is returning the result.
      resultDelivery.consume(ids);

      const sections: string[] = [];
      let remainingBytes = WAIT_OUTPUT_MAX_BYTES;
      for (const id of ids) {
        const snap = manager.view.get(id);
        if (!snap) {
          sections.push(`## ${id}\n\n(no longer tracked)`);
          continue;
        }
        const verb = snap.status === "error" ? "failed" : "finished";
        let section = `## ${snap.id} "${snap.title}" ${verb}`;
        if (snap.errorText) section += `\nError: ${snap.errorText}`;
        const headerBytes = Buffer.byteLength(section, "utf8") + 2;
        const outputBudget = Math.max(
          512,
          Math.min(WAIT_PER_AGENT_MAX_BYTES, remainingBytes - headerBytes),
        );
        section += `\n\n${truncatedOutput(snap, outputBudget)}`;
        const sectionBytes = Buffer.byteLength(section, "utf8");
        if (sectionBytes > remainingBytes) {
          sections.push(
            `## ${snap.id} "${snap.title}"\n\n[omitted: total wait output limit reached]`,
          );
          break;
        }
        sections.push(section);
        remainingBytes -= sectionBytes;
      }

      const combined = sections.join("\n\n---\n\n");
      const bounded = truncateHead(combined, {
        maxBytes: WAIT_OUTPUT_MAX_BYTES - 128,
        maxLines: DEFAULT_MAX_LINES,
      });
      const text = bounded.truncated
        ? `${bounded.content}\n\n[wait output truncated at the total output limit]`
        : bounded.content;
      return {
        content: [{ type: "text", text }],
        details: {
          results: ids.map((id) => {
            const snap = manager.view.get(id);
            return { id, title: snap?.title, status: snap?.status };
          }),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_cancel",
    label: "Cancel Subagents",
    description: SUBAGENT_CANCEL_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        description: SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS.ids,
      }),
    }),
    async execute(_toolCallId, params, signal) {
      const manager = await getManager();
      const ids = [...new Set(params.ids)];
      if (ids.length === 0)
        throw new Error("Provide at least one subagent id.");

      const known = manager.view
        .list()
        .filter(isModelVisible)
        .map((snap) => snap.id);
      const unknown = ids.filter((id) => {
        const snap = manager.view.get(id);
        return !snap || !isModelVisible(snap);
      });
      if (unknown.length > 0) {
        throw new Error(
          `Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      const report = await runTool(getRuntime(), manager.cancel(ids), {
        signal,
        interruptMessage: "Subagent cancellation aborted.",
      });

      const lines = report.map((entry) =>
        entry.cancelled
          ? `Cancelled ${entry.id} "${entry.title}".`
          : `${entry.id} "${entry.title}" was already ${entry.status}.`,
      );

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          results: report.map((entry) => ({
            id: entry.id,
            title: entry.title,
            status: entry.status,
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_check",
    label: "Check Subagent",
    description: SUBAGENT_CHECK_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({
        description: SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS.id,
      }),
    }),
    async execute(_toolCallId, params) {
      const manager = await getManager();
      const snap = manager.view.get(params.id);
      if (!snap || !isModelVisible(snap)) {
        const known = manager.view
          .list()
          .filter(isModelVisible)
          .map((s) => s.id);
        throw new Error(
          `Unknown subagent id "${params.id}". Known: ${known.join(", ") || "none"}.`,
        );
      }

      let text = `${describeSubagent(snap)}\nTurns: ${snap.turns}`;
      if (snap.errorText) text += `\nError: ${snap.errorText}`;

      const output = latestText(snap);
      if (output) {
        const preview = truncateHead(output, { maxBytes: 2048, maxLines: 20 });
        text += `\n\nLatest output:\n${preview.content}`;
        if (preview.truncated) text += "\n[...]";
      } else if (snap.status === "running") {
        text += "\n\n(no text output yet)";
      }

      return {
        content: [{ type: "text", text }],
        details: { id: snap.id, status: snap.status, turns: snap.turns },
      };
    },
  });

  pi.registerTool({
    name: "subagent_list",
    label: "List Subagents",
    description: SUBAGENT_LIST_TOOL_DESCRIPTION,
    parameters: Type.Object({}),
    async execute() {
      const manager = await getManager();
      const subs = manager.view.list().filter(isModelVisible);
      const text =
        subs.length === 0
          ? "No subagents."
          : subs.map((snap) => describeSubagent(snap)).join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          subagents: subs.map((snap) => ({
            id: snap.id,
            title: snap.title,
            harness: snap.backend,
            status: snap.status,
          })),
        },
      };
    },
  });

  // --- Result message rendering ------------------------------------------

  pi.registerMessageRenderer(
    "subagent-result",
    (message, { expanded }, theme) => {
      const details = (message.details ?? {}) as {
        id?: string;
        title?: string;
        status?: string;
      };
      const failed = details.status === "error";
      const icon = failed ? theme.fg("error", "x") : theme.fg("success", "■");
      const header =
        `${icon} ` +
        theme.fg("accent", theme.bold(`subagent ${details.id ?? "?"}`)) +
        theme.fg(
          "muted",
          ` · ${details.title ?? ""} · ${failed ? "failed" : "finished"}`,
        );

      const content =
        typeof message.content === "string" ? message.content : "";
      // Remove only the summary line. The following Error line (when present)
      // is part of the actual result and must remain visible.
      const body = content.split("\n").slice(1).join("\n").trim();

      if (expanded) {
        const md = new Markdown(`${body}`, 0, 0, getMarkdownTheme());
        const container = new Text(header, 0, 0);
        return {
          render: (width: number) => [
            ...container.render(width),
            ...md.render(width),
          ],
          invalidate: () => {
            container.invalidate();
            md.invalidate();
          },
        };
      }

      const previewLines = body.split("\n").slice(0, 8);
      let text = header;
      for (const line of previewLines)
        text += `\n${theme.fg("toolOutput", line)}`;
      if (body.split("\n").length > 8)
        text += `\n${theme.fg("dim", "... (ctrl+o to expand)")}`;
      return new Text(text, 0, 0);
    },
  );

  pi.registerEntryRenderer<BtwResultData>(
    "btw-result",
    (entry, { expanded }, theme) => {
      const data = entry.data;
      const failed = data?.status === "error";
      const icon = failed ? theme.fg("error", "x") : theme.fg("success", "■");
      const header =
        `${icon} ` +
        theme.fg("accent", theme.bold(`by the way · ${data?.title ?? "?"}`)) +
        theme.fg(
          "muted",
          ` · ${failed ? "failed" : "answered"} · ${data?.id ?? "?"}`,
        );
      const body = [
        data?.errorText ? `Error: ${data.errorText}` : "",
        data?.answer ?? "(no answer)",
      ]
        .filter(Boolean)
        .join("\n\n");

      if (expanded) {
        const md = new Markdown(body, 0, 0, getMarkdownTheme());
        const container = new Text(header, 0, 0);
        return {
          render: (width: number) => [
            ...container.render(width),
            ...md.render(width),
          ],
          invalidate: () => {
            container.invalidate();
            md.invalidate();
          },
        };
      }

      const lines = body.split("\n");
      let text = header;
      for (const line of lines.slice(0, 8))
        text += `\n${theme.fg("toolOutput", line)}`;
      if (lines.length > 8)
        text += `\n${theme.fg("dim", "... (ctrl+o to expand)")}`;
      return new Text(text, 0, 0);
    },
  );

  // --- Commands -----------------------------------------------------------

  const parentContext = (ctx: ExtensionContext) => ({
    parentCwd: ctx.cwd,
    projectTrusted: ctx.isProjectTrusted(),
    inheritedModel: ctx.model
      ? { provider: ctx.model.provider, id: ctx.model.id }
      : undefined,
    inheritedThinkingLevel: pi.getThinkingLevel(),
    modelRegistry: ctx.modelRegistry,
  });

  const takeoverOptions = (snap: SubagentSnapshot) => ({
    badge: snap.profile === "worker" ? "by the way worker" : "by the way",
    allowQueueToParent: snap.origin === "btw",
    allowWorkerHandoff: snap.origin === "btw" && snap.profile !== "worker",
  });

  const queueLatestToParent = (ctx: ExtensionContext, snap: SubagentSnapshot) => {
    const answer = latestText(snap).trim();
    if (!answer) {
      ctx.ui.notify("No BTW answer is available to queue.", "warning");
      return;
    }
    const message = buildBtwParentHandoff(snap.title, answer);
    if (ctx.isIdle()) pi.sendUserMessage(message);
    else pi.sendUserMessage(message, { deliverAs: "followUp" });
    ctx.ui.notify("Latest BTW answer queued to the parent thread.", "info");
  };

  const spawnApprovedBtwWorker = async (
    ctx: ExtensionContext,
    planner: SubagentSnapshot,
  ) => {
    const draft = buildBtwWorkerContract(planner.prompt, planner.finalText);
    const contract = (await ctx.ui.editor("Review the worker contract", draft))?.trim();
    if (!contract) return;

    const contractApproved = await ctx.ui.confirm(
      "Approve this work contract?",
      "This exact contract will become the worker's authoritative scope. Continue to executioner selection?",
    );
    if (!contractApproved) return;

    const choices: Array<{ label: string; harness: BackendName }> = [
      { label: "Pi worker — project-confined edits, no shell", harness: "pi" },
      { label: "Codex worker — sandboxed project execution", harness: "codex" },
      { label: "Claude worker — sandboxed project execution", harness: "claude" },
    ];
    const selected = await ctx.ui.select(
      "Choose the worker executioner",
      choices.map((choice) => choice.label),
    );
    const harness = choices.find((choice) => choice.label === selected)?.harness;
    if (!harness) return;

    const configured = resolveSpawnConfig(await loadSubagentConfig(), {
      harness,
      profile: "worker",
    });
    const executionApproved = await ctx.ui.confirm(
      "Approve worker execution?",
      [
        `Harness: ${configured.harness}`,
        `Model: ${configured.model ?? "native/inherited default"}`,
        `Effort: ${configured.reasoningEffort ?? "native/inherited default"}`,
        "Profile: worker (project-confined edits)",
        `Working directory: ${ctx.cwd}`,
        "The parent may still be active. Avoid approving overlapping file edits unless the contract makes coordination explicit.",
      ].join("\n"),
    );
    if (!executionApproved) return;

    const manager = await getManager();
    try {
      return await runTool(
        getRuntime(),
        manager.spawn(configured.harness, {
          origin: "btw",
          prompt: [
            "You are the execution worker for a user-approved BTW handoff.",
            "The approved work contract below is authoritative. Do not expand scope or guess through a stop condition.",
            "",
            contract,
          ].join("\n"),
          title: deriveBtwTitle(`Execute: ${planner.title}`),
          cwd: ctx.cwd,
          model: configured.model,
          reasoningEffort: configured.reasoningEffort,
          profile: "worker",
          parent: parentContext(ctx),
        }),
      );
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error ? error.message : String(error),
        "error",
      );
      return;
    }
  };

  const handleTakeoverAction = async (
    ctx: ExtensionContext,
    action: TakeoverAction,
    snap: SubagentSnapshot,
  ) => {
    if (action === "queue-latest") {
      queueLatestToParent(ctx, snap);
      return;
    }
    const worker = await spawnApprovedBtwWorker(ctx, snap);
    if (!worker) return;
    const workerAction = await openSubagentTakeover(
      ctx,
      (await getManager()).view,
      worker.id,
      takeoverOptions(worker),
    );
    if (workerAction === "queue-latest") queueLatestToParent(ctx, worker);
  };

  const runByTheWay = async (rawArgs: string, ctx: ExtensionCommandContext) => {
    if (ctx.mode !== "tui") {
      if (ctx.hasUI)
        ctx.ui.notify("by the way is only available in the TUI", "error");
      return;
    }

    let prompt = rawArgs.trim();
    if (!prompt) {
      const input = await ctx.ui.input("by the way", "Ask a one-off question…");
      prompt = input?.trim() ?? "";
      if (!prompt) return;
    }

    const manager = await getManager();
    let snap: SubagentSnapshot;
    try {
      const configured = resolveSpawnConfig(await loadSubagentConfig(), {
        harness: "pi",
      });
      snap = await runTool(
        getRuntime(),
        manager.spawn("pi", {
          origin: "btw",
          prompt,
          title: deriveBtwTitle(prompt),
          cwd: ctx.cwd,
          model: configured.model,
          reasoningEffort: configured.reasoningEffort,
          // Side questions must remain read-only even when Pi's general
          // harness default is configured for project editing.
          profile: "scout",
          parent: parentContext(ctx),
        }),
      );
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error ? error.message : String(error),
        "error",
      );
      return;
    }

    const action = await openSubagentTakeover(
      ctx,
      manager.view,
      snap.id,
      takeoverOptions(snap),
    );
    if (action) await handleTakeoverAction(ctx, action, snap);
  };

  pi.registerCommand("btw", {
    description:
      "Ask a one-off side question while the main agent keeps working",
    handler: runByTheWay,
  });

  const openSubagents = async (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") {
      if (ctx.hasUI)
        ctx.ui.notify(
          "Subagent takeover is only available in the TUI",
          "error",
        );
      return;
    }
    const manager = await getManager();
    if (manager.view.size() === 0) {
      ctx.ui.notify(
        "No subagents yet. The agent spawns them with subagent_spawn.",
        "info",
      );
      return;
    }
    await openSubagentPicker(ctx, manager.view, {
      takeoverOptions: (snap) =>
        snap.origin === "btw" ? takeoverOptions(snap) : undefined,
      onAction: (action, snap) => handleTakeoverAction(ctx, action, snap),
    });
  };

  pi.registerCommand("subagents", {
    description: "List, inspect, take over, and configure subagents",
    handler: async (_args, ctx) => openSubagents(ctx),
  });

  pi.registerCommand("subagent-settings", {
    description: "Configure subagent harness defaults, models, and presets",
    handler: async (_args, ctx) => openSubagentSettings(ctx),
  });

  pi.registerShortcut("alt+s", {
    description: "Open subagents",
    handler: openSubagents,
  });
}
