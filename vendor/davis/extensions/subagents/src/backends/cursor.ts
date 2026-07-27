import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Cause, Scope } from "effect";
import { Effect, Queue, Stream } from "effect";
import type { SubagentBackend, SubagentSession } from "../backend.ts";
import type {
  RunOutcome,
  SpawnTask,
  SubagentEvent,
  SubagentMeta,
  TranscriptPart,
} from "../domain.ts";
import { SendError, SpawnError } from "../domain.ts";

const FORCE_KILL_AFTER_MS = 2_000;
const STDOUT_BUFFER_MAX_BYTES = 4 * 1024 * 1024;
const PREVIEW_MAX_LENGTH = 1_024;

type JsonRecord = Record<string, unknown>;

export interface CursorModelOption {
  readonly id: string;
  readonly label: string;
}

export type ParsedCursorEvent =
  | { readonly type: "meta"; readonly sessionId?: string; readonly model?: string }
  | { readonly type: "assistant"; readonly text: string; readonly delta: boolean }
  | {
      readonly type: "tool-start";
      readonly id: string;
      readonly name: string;
      readonly args?: string;
    }
  | {
      readonly type: "tool-end";
      readonly id: string;
      readonly name: string;
      readonly output?: string;
      readonly isError: boolean;
    }
  | { readonly type: "usage"; readonly tokens?: number }
  | { readonly type: "result"; readonly outcome: RunOutcome }
  | { readonly type: "diagnostic"; readonly message: string };

let cachedCursorBinary: string | undefined;
let cachedModels: CursorModelOption[] | undefined;

function executable(file: string) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveCursorBinary() {
  if (cachedCursorBinary && executable(cachedCursorBinary)) {
    return cachedCursorBinary;
  }
  const names = process.platform === "win32"
    ? ["cursor-agent.exe", "agent.exe"]
    : ["cursor-agent", "agent"];
  const directories = [
    ...(process.env.PATH ?? "").split(path.delimiter),
    path.join(os.homedir(), ".local", "bin"),
  ];
  for (const name of names) {
    for (const directory of directories) {
      if (!directory) continue;
      const candidate = path.join(directory, name);
      if (executable(candidate)) {
        cachedCursorBinary = candidate;
        return candidate;
      }
    }
  }
  cachedCursorBinary = undefined;
  return undefined;
}

function boundedError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function booleanValue(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeJson(value: unknown) {
  try {
    const text = JSON.stringify(value);
    return text && text !== "{}" ? text.slice(0, PREVIEW_MAX_LENGTH) : undefined;
  } catch {
    return undefined;
  }
}

function firstLine(value: unknown) {
  const text = stringValue(value);
  return text?.split("\n").find((line) => line.trim())?.trim().slice(0, PREVIEW_MAX_LENGTH);
}

function contentText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .flatMap((part) => {
      const item = record(part);
      const value = stringValue(item?.text) ?? stringValue(item?.content);
      return value ? [value] : [];
    })
    .join("\n");
  return text || undefined;
}

function nested(recordValue: JsonRecord, ...keys: string[]) {
  let current: unknown = recordValue;
  for (const key of keys) current = record(current)?.[key];
  return current;
}

/** Tolerant parser for Cursor's evolving NDJSON stream. Unknown records become diagnostics. */
export function parseCursorProtocolLine(line: string): ParsedCursorEvent[] {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return [{ type: "diagnostic", message: `Invalid Cursor protocol line: ${line.slice(0, 512)}` }];
  }
  const item = record(value);
  if (!item) return [];
  const type = stringValue(item.type) ?? stringValue(item.event) ?? "";
  const subtype = stringValue(item.subtype) ?? stringValue(item.status) ?? "";

  if (type === "system" || type === "init" || subtype === "init") {
    return [{
      type: "meta",
      sessionId:
        stringValue(item.session_id) ??
        stringValue(item.sessionId) ??
        stringValue(item.chat_id) ??
        stringValue(item.chatId),
      model: stringValue(item.model),
    }];
  }

  const event = record(item.event);
  const eventType = stringValue(event?.type);
  if (type === "stream_event" && eventType === "content_block_delta") {
    const delta = record(event?.delta);
    const text = stringValue(delta?.text) ?? stringValue(delta?.content);
    return text ? [{ type: "assistant", text, delta: true }] : [];
  }

  if (type === "assistant" || type === "assistant_message" || type === "message") {
    const message = record(item.message);
    const text =
      contentText(message?.content) ??
      contentText(item.content) ??
      stringValue(item.text);
    return text ? [{ type: "assistant", text, delta: false }] : [];
  }

  if (type.includes("tool") || item.tool_call || item.toolCall) {
    const tool = record(item.tool_call) ?? record(item.toolCall) ?? record(item.tool) ?? item;
    const variantEntry = Object.entries(tool).find(
      ([key, value]) => key.endsWith("ToolCall") && record(value),
    );
    const variant = record(variantEntry?.[1]);
    const id =
      stringValue(item.call_id) ??
      stringValue(tool.toolCallId) ??
      stringValue(tool.id) ??
      stringValue(tool.tool_call_id) ??
      stringValue(item.id) ??
      "cursor-tool";
    const name =
      (variantEntry?.[0] ? variantEntry[0].replace(/ToolCall$/, "") : undefined) ??
      stringValue(tool.name) ??
      stringValue(tool.tool_name) ??
      stringValue(item.name) ??
      "Cursor tool";
    const completed =
      subtype === "completed" ||
      subtype === "success" ||
      subtype === "failed" ||
      type.includes("result") ||
      item.result !== undefined ||
      item.output !== undefined;
    if (completed) {
      const result = variant?.result ?? item.output ?? item.result;
      const success = record(record(result)?.success);
      const failure = record(record(result)?.error) ?? record(record(result)?.failure);
      return [{
        type: "tool-end",
        id,
        name,
        output:
          firstLine(success?.content) ??
          firstLine(failure?.message) ??
          firstLine(result) ??
          safeJson(result),
        isError:
          Boolean(failure) ||
          booleanValue(item.is_error) === true ||
          booleanValue(item.isError) === true ||
          subtype === "failed",
      }];
    }
    return [{
      type: "tool-start",
      id,
      name,
      args: safeJson(variant?.args ?? tool.arguments ?? tool.input ?? item.arguments),
    }];
  }

  if (type === "result" || type === "final" || subtype === "success" || subtype === "error") {
    const text =
      stringValue(item.result) ??
      stringValue(item.text) ??
      contentText(nested(item, "message", "content")) ??
      "";
    const error =
      stringValue(item.error) ??
      stringValue(record(item.error)?.message) ??
      (Array.isArray(item.errors) ? item.errors.filter((x): x is string => typeof x === "string").join("\n") : undefined);
    const failed =
      booleanValue(item.is_error) === true ||
      booleanValue(item.isError) === true ||
      subtype === "error" ||
      subtype === "failed";
    const usage = record(item.usage);
    const inputTokens = numberValue(usage?.inputTokens) ?? 0;
    const cacheReadTokens = numberValue(usage?.cacheReadTokens) ?? 0;
    const outputTokens = numberValue(usage?.outputTokens) ?? 0;
    return [
      ...(usage
        ? [{
            type: "usage" as const,
            tokens: inputTokens + cacheReadTokens + outputTokens,
          }]
        : []),
      {
        type: "result",
        outcome: failed
          ? { _tag: "Failed", errorText: error || "Cursor agent failed", partialText: text || undefined }
          : { _tag: "Completed", finalText: text },
      },
    ];
  }

  const sessionId =
    stringValue(item.session_id) ?? stringValue(item.sessionId) ?? stringValue(item.chatId);
  return sessionId ? [{ type: "meta", sessionId }] : [];
}

export function mergeCursorAssistantText(
  current: string,
  lastMessage: string,
  nextMessage: string,
) {
  if (nextMessage === lastMessage) return { text: current, changed: false };
  if (!current || nextMessage.startsWith(current)) {
    return { text: nextMessage, changed: true };
  }
  if (current.endsWith(nextMessage)) return { text: current, changed: true };
  return { text: `${current}\n${nextMessage}`, changed: true };
}

export function parseCursorModels(output: string): CursorModelOption[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .map((line) => /^(\S+)\s+-\s+(.+)$/.exec(line))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => ({ id: match[1]!, label: match[2]!.trim() }));
}

export async function listCursorModels(options: { refresh?: boolean } = {}) {
  if (cachedModels?.length && !options.refresh) return cachedModels;
  const binary = resolveCursorBinary();
  if (!binary) return [];
  const output = await new Promise<string>((resolve, reject) => {
    execFile(binary, ["--list-models"], { encoding: "utf8", timeout: 5_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr).trim() || error.message));
      else resolve(stdout);
    });
  });
  const parsed = parseCursorModels(output);
  if (parsed.length > 0) cachedModels = parsed;
  return parsed;
}

export function cursorPromptForProfile(task: SpawnTask, prompt: string) {
  const profile = task.profile ?? "scout";
  const policy =
    profile === "researcher"
      ? "Read-only researcher policy: do not modify files or run mutating commands. Web research is allowed only when needed for the task."
      : "Read-only scout policy: use only local workspace evidence. Do not access the web or network, modify files, or run mutating commands.";
  return `${policy}\n\n${prompt}`;
}

export function cursorArgs(task: SpawnTask, prompt: string, sessionId?: string) {
  return [
    "--print",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--mode",
    "plan",
    "--sandbox",
    "enabled",
    "--trust",
    "--workspace",
    task.cwd,
    ...(sessionId ? ["--resume", sessionId] : []),
    ...(task.model && task.model !== "auto" ? ["--model", task.model] : []),
    cursorPromptForProfile(task, prompt),
  ];
}

function killTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  try {
    child.kill(signal);
  } catch {}
}

export function terminateCursorProcess(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(force);
      clearTimeout(last);
      resolve();
    };
    child.once("exit", finish);
    killTree(child, "SIGTERM");
    const force = setTimeout(() => killTree(child, "SIGKILL"), FORCE_KILL_AFTER_MS);
    const last = setTimeout(finish, FORCE_KILL_AFTER_MS + 500);
  });
}

const makeCursorSession = (
  task: SpawnTask,
): Effect.Effect<SubagentSession, SpawnError, Scope.Scope> =>
  Effect.gen(function* () {
    const profile = task.profile ?? "scout";
    if (profile === "worker" || profile === "unrestricted") {
      return yield* new SpawnError({
        message: "Cursor subagents currently support only scout and researcher profiles; unattended editing remains disabled.",
      });
    }
    const binary = resolveCursorBinary();
    if (!binary) {
      return yield* new SpawnError({ message: "cursor-agent executable was not found." });
    }
    if (task.model && task.model !== "auto") {
      const models = yield* Effect.tryPromise({
        try: () => listCursorModels(),
        catch: (error) => new SpawnError({ message: boundedError(error) }),
      });
      if (models.length > 0 && !models.some((model) => model.id === task.model)) {
        return yield* new SpawnError({
          message: `Cursor model "${task.model}" is not available. Open /subagent-settings to choose from the current catalog.`,
        });
      }
    }

    const events = yield* Queue.make<SubagentEvent, Cause.Done>();
    const emit = (event: SubagentEvent) => Queue.offerUnsafe(events, event);
    const children = new Set<ChildProcessWithoutNullStreams>();
    const state = {
      closed: false,
      active: false,
      interrupted: false,
      current: undefined as ChildProcessWithoutNullStreams | undefined,
      queued: [] as string[],
      sessionId: undefined as string | undefined,
      finalText: "",
      lastAssistantMessage: "",
      stderr: "",
      meta: {
        backend: "cursor",
        modelLabel: task.model ?? "auto",
      } satisfies SubagentMeta as SubagentMeta,
    };

    const queuedView = () => state.queued.map((text) => ({ text, kind: "follow-up" as const }));

    const settle = (outcome: RunOutcome) => {
      if (!state.active) return;
      const settledChild = state.current;
      state.active = false;
      state.current = undefined;
      emit({ _tag: "RunSettled", outcome });
      // A result event normally precedes process exit. Retain ownership and
      // terminate a child that fails to exit after reporting completion.
      if (settledChild && children.has(settledChild)) {
        const timer = setTimeout(() => {
          if (children.has(settledChild)) void terminateCursorProcess(settledChild);
        }, 1_000);
        timer.unref();
      }
      const next = state.queued.shift();
      emit({ _tag: "QueueChanged", queued: queuedView() });
      if (next !== undefined && !state.closed) startRun(next);
    };

    const applyParsed = (parsed: ParsedCursorEvent) => {
      switch (parsed.type) {
        case "meta": {
          if (parsed.sessionId) state.sessionId = parsed.sessionId;
          state.meta = {
            ...state.meta,
            ...(parsed.sessionId ? { nativeSessionId: parsed.sessionId } : {}),
            ...(parsed.model ? { modelLabel: parsed.model } : {}),
          };
          emit({ _tag: "MetaChanged", meta: state.meta });
          break;
        }
        case "assistant":
          if (parsed.delta) {
            state.finalText += parsed.text;
            emit({ _tag: "AssistantDelta", kind: "text", delta: parsed.text });
          } else {
            const merged = mergeCursorAssistantText(
              state.finalText,
              state.lastAssistantMessage,
              parsed.text,
            );
            if (!merged.changed) break;
            state.finalText = merged.text;
            state.lastAssistantMessage = parsed.text;
            emit({
              _tag: "AssistantMessage",
              parts: [{ type: "text", text: parsed.text }],
            });
          }
          break;
        case "tool-start": {
          const part: TranscriptPart = {
            type: "toolCall",
            toolId: parsed.id,
            name: parsed.name,
            argsPreview: parsed.args,
          };
          emit({ _tag: "AssistantMessage", parts: [part] });
          emit({ _tag: "ToolStart", toolId: parsed.id, name: parsed.name, argsPreview: parsed.args });
          break;
        }
        case "tool-end":
          emit({
            _tag: "ToolEnd",
            toolId: parsed.id,
            name: parsed.name,
            isError: parsed.isError,
            outputPreview: parsed.output,
          });
          break;
        case "usage":
          emit({
            _tag: "UsageChanged",
            tokens: parsed.tokens,
            costKnown: false,
          });
          break;
        case "result":
          settle(
            parsed.outcome._tag === "Completed" && !parsed.outcome.finalText
              ? { _tag: "Completed", finalText: state.finalText }
              : parsed.outcome,
          );
          break;
        case "diagnostic":
          emit({ _tag: "BackendError", message: parsed.message });
      }
    };

    function startRun(prompt: string) {
      if (state.closed || state.active) return;
      state.active = true;
      state.interrupted = false;
      state.finalText = "";
      state.lastAssistantMessage = "";
      state.stderr = "";
      emit({ _tag: "UserMessage", text: prompt });
      emit({ _tag: "RunStarted" });

      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(binary!, cursorArgs(task, prompt, state.sessionId), {
          cwd: task.cwd,
          env: process.env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          detached: process.platform !== "win32",
        });
      } catch (error) {
        settle({ _tag: "Failed", errorText: boundedError(error) });
        return;
      }
      state.current = child;
      children.add(child);
      child.stdin.end();
      let stdoutBuffer = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutBuffer += chunk;
        while (true) {
          const newline = stdoutBuffer.indexOf("\n");
          if (newline < 0) break;
          const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          if (line.trim()) for (const parsed of parseCursorProtocolLine(line)) applyParsed(parsed);
        }
        if (stdoutBuffer.length > STDOUT_BUFFER_MAX_BYTES) {
          stdoutBuffer = "";
          void terminateCursorProcess(child);
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        state.stderr = `${state.stderr}${chunk}`.slice(-4096);
      });
      child.once("error", (error) => {
        settle({ _tag: "Failed", errorText: `Cursor agent failed: ${boundedError(error)}`, partialText: state.finalText || undefined });
      });
      child.once("exit", (code, signal) => {
        children.delete(child);
        if (!state.active || state.current !== child) return;
        if (state.interrupted) {
          settle({ _tag: "Interrupted", partialText: state.finalText || undefined });
        } else if (code === 0) {
          settle({ _tag: "Completed", finalText: state.finalText });
        } else {
          settle({
            _tag: "Failed",
            errorText: `Cursor agent exited (${signal ?? `code ${code ?? "unknown"}`})${state.stderr.trim() ? `: ${state.stderr.trim()}` : ""}`.slice(0, 4096),
            partialText: state.finalText || undefined,
          });
        }
      });
    }

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        state.closed = true;
        state.queued = [];
        emit({ _tag: "QueueChanged", queued: [] });
        state.interrupted = true;
        await Promise.all([...children].map((child) => terminateCursorProcess(child)));
        children.clear();
        if (state.active) settle({ _tag: "Interrupted", partialText: state.finalText || undefined });
        Queue.endUnsafe(events);
      }),
    );

    emit({ _tag: "MetaChanged", meta: state.meta });
    startRun(task.prompt);

    return {
      meta: Effect.sync(() => state.meta),
      events: Stream.fromQueue(events),
      send: (text) =>
        Effect.suspend((): Effect.Effect<void, SendError> => {
          if (state.closed) return new SendError({ message: "Subagent session is closed." });
          if (state.active) {
            state.queued.push(text);
            emit({ _tag: "QueueChanged", queued: queuedView() });
          } else {
            startRun(text);
          }
          return Effect.void;
        }),
      interrupt: Effect.promise(async () => {
        if (!state.active || !state.current) return;
        state.interrupted = true;
        state.queued = [];
        emit({ _tag: "QueueChanged", queued: [] });
        await terminateCursorProcess(state.current);
      }),
    } satisfies SubagentSession;
  });

export const cursorBackend: SubagentBackend = {
  name: "cursor",
  capabilities: { steering: false, modelSelection: true, reasoningEffort: false },
  available: Effect.sync(() => resolveCursorBinary() !== undefined),
  spawn: makeCursorSession,
};
