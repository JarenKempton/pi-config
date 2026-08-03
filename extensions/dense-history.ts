import type {
  ExtensionAPI,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type AssistantInstance = {
  hideThinkingBlock: boolean;
  setHideThinkingBlock(hidden: boolean): void;
  updateContent(message: unknown): void;
};

type CompactionInstance = {
  expanded: boolean;
  message: { tokensBefore: number };
  render(width: number): string[];
};

type ToolResult = {
  content: Array<{ type: string; text?: string }>;
  isError: boolean;
};

type ToolExecutionInstance = {
  toolName: string;
  args: Record<string, unknown>;
  expanded: boolean;
  isPartial: boolean;
  result?: ToolResult;
  updateResult(result: ToolResult, isPartial?: boolean): void;
  render(width: number): string[];
};

type HostPiModule = {
  AssistantMessageComponent: {
    prototype: AssistantInstance;
  };
  CompactionSummaryMessageComponent: {
    prototype: CompactionInstance;
  };
  ToolExecutionComponent: {
    prototype: ToolExecutionInstance;
  };
  keyText(binding: string): string;
};

type DenseHistoryState = {
  activeTurn: boolean;
  theme?: Theme;
  touchedThinking: Set<AssistantInstance>;
  touchedTools: Set<ToolExecutionInstance>;
};

const PATCH_KEY = Symbol.for("jaren.pi.dense-history.patch");
const TOOL_PATCH_KEY = Symbol.for("jaren.pi.dense-history.tool-patch");

async function loadHostPiModule(): Promise<HostPiModule> {
  // Pi packages may carry a peer dependency copy that differs from the CLI's
  // live module instance. Resolve index.js beside the running CLI so the patch
  // affects the components actually mounted in the transcript.
  const cliPath = process.argv[1];
  if (!cliPath) {
    throw new Error("Cannot locate the running Pi CLI module");
  }

  const resolvedCliPath = realpathSync(cliPath);
  const hostIndexUrl = pathToFileURL(
    resolve(dirname(resolvedCliPath), "index.js"),
  ).href;
  return (await import(hostIndexUrl)) as HostPiModule;
}

function inlineText(value: unknown) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstString(args: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return inlineText(value);
  }
  return "";
}

function describeTool(instance: ToolExecutionInstance) {
  const { args, toolName } = instance;
  if (toolName === "bash") return firstString(args, ["command"]);
  if (toolName === "grep") {
    const pattern = firstString(args, ["pattern", "query"]);
    const path = firstString(args, ["path"]);
    return [pattern, path].filter(Boolean).join(" · ");
  }
  if (toolName === "subagent_spawn") {
    return firstString(args, ["name", "model", "harness"]);
  }
  return firstString(args, [
    "path",
    "url",
    "query",
    "name",
    "id",
    "task",
    "question",
  ]);
}

function summarizeResult(result: ToolResult | undefined) {
  if (!result) return "done";
  if (result.isError) return "error";
  const output = result.content
    .filter((item) => item.type === "text" && item.text)
    .map((item) => item.text)
    .join("\n")
    .trim();
  if (!output) return "done";
  const lines = output.split(/\r?\n/).length;
  return `${lines} ${lines === 1 ? "line" : "lines"}`;
}

export function renderCompactToolLine(
  instance: ToolExecutionInstance,
  theme: Theme,
  expandKey: string,
  width: number,
) {
  const title = theme.fg("toolTitle", instance.toolName);
  const outcomeText = summarizeResult(instance.result);
  const outcome = theme.fg(
    instance.result?.isError ? "error" : "muted",
    outcomeText,
  );
  const prefix = `${theme.fg("dim", "↳ ")}${title}${theme.fg("dim", " · ")}${outcome}`;
  const suffix = theme.fg("dim", ` · ${expandKey} expand`);
  const description = describeTool(instance);
  if (!description) return [truncateToWidth(`${prefix}${suffix}`, width)];

  const separator = theme.fg("dim", " · ");
  const available = Math.max(
    1,
    width - visibleWidth(prefix) - visibleWidth(separator) - visibleWidth(suffix),
  );
  const detail = theme.fg("muted", truncateToWidth(description, available, "…"));
  return [truncateToWidth(`${prefix}${separator}${detail}${suffix}`, width)];
}

export function installDenseHistoryPatch(host: HostPiModule): DenseHistoryState {
  const assistantPrototype = host.AssistantMessageComponent.prototype as AssistantInstance & {
    [PATCH_KEY]?: DenseHistoryState;
  };
  const compactionPrototype = host.CompactionSummaryMessageComponent.prototype as CompactionInstance & {
    [PATCH_KEY]?: DenseHistoryState;
  };
  const toolPrototype = host.ToolExecutionComponent.prototype as ToolExecutionInstance & {
    [TOOL_PATCH_KEY]?: boolean;
  };

  let state = assistantPrototype[PATCH_KEY];
  if (!state) {
    state = {
      activeTurn: false,
      touchedThinking: new Set(),
      touchedTools: new Set(),
    };

    const originalUpdateContent = assistantPrototype.updateContent;
    assistantPrototype.updateContent = function (message) {
      if (state.activeTurn) {
        // The global preference keeps settled reasoning collapsed. Temporarily
        // reveal the component receiving the live stream, then collapse it in
        // turn_end below.
        this.hideThinkingBlock = false;
        state.touchedThinking.add(this);
      }
      originalUpdateContent.call(this, message);
    };

    const originalCompactionRender = compactionPrototype.render;
    compactionPrototype.render = function (width) {
      if (this.expanded) return originalCompactionRender.call(this, width);

      const tokenCount = this.message.tokensBefore.toLocaleString();
      const hint = host.keyText("app.tools.expand");
      const plain = `↳ Compacted ${tokenCount} tokens · ${hint} to expand`;
      const text = state.theme
        ? state.theme.fg("dim", `↳ Compacted ${tokenCount} tokens · `) +
          state.theme.fg("muted", `${hint} to expand`)
        : plain;

      return [truncateToWidth(text, Math.max(1, width))];
    };

    assistantPrototype[PATCH_KEY] = state;
    compactionPrototype[PATCH_KEY] = state;
  }

  // A /reload can reuse state installed by an older version of this extension.
  state.touchedTools ??= new Set();
  if (!toolPrototype[TOOL_PATCH_KEY]) {
    const originalUpdateResult = toolPrototype.updateResult;
    toolPrototype.updateResult = function (result, isPartial = false) {
      if (state.activeTurn) state.touchedTools.add(this);
      originalUpdateResult.call(this, result, isPartial);
    };

    const originalToolRender = toolPrototype.render;
    toolPrototype.render = function (width) {
      const shouldCollapse =
        !this.expanded &&
        !this.isPartial &&
        this.result !== undefined &&
        !state.touchedTools.has(this);
      if (!shouldCollapse || !state.theme) {
        return originalToolRender.call(this, width);
      }
      return renderCompactToolLine(
        this,
        state.theme,
        host.keyText("app.tools.expand"),
        width,
      );
    };
    toolPrototype[TOOL_PATCH_KEY] = true;
  }

  return state;
}

export default async function (pi: ExtensionAPI) {
  const state = installDenseHistoryPatch(await loadHostPiModule());

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    state.theme = ctx.ui.theme;
    state.activeTurn = false;
    state.touchedThinking.clear();
    state.touchedTools.clear();
    ctx.ui.setHiddenThinkingLabel("Reasoning · Ctrl+T to expand");
  });

  pi.on("turn_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    state.activeTurn = true;
    state.touchedThinking.clear();
    state.touchedTools.clear();
  });

  pi.on("turn_end", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    state.activeTurn = false;

    for (const component of state.touchedThinking) {
      component.setHideThinkingBlock(true);
    }
    state.touchedThinking.clear();
    state.touchedTools.clear();

    // Updating the label also requests a render through the public UI API.
    ctx.ui.setHiddenThinkingLabel("Reasoning · Ctrl+T to expand");
  });

  pi.on("session_shutdown", () => {
    state.activeTurn = false;
    state.touchedThinking.clear();
    state.touchedTools.clear();
  });
}
