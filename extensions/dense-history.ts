import type {
  ExtensionAPI,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
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
const TOOL_PATCH_KEY = Symbol.for("jaren.pi.dense-history.tool-patch.v2");

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
        // reveal the component receiving the live stream, then collapse it
        // only after the complete agent run settles.
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
      return shouldCollapse ? [] : originalToolRender.call(this, width);
    };
    toolPrototype[TOOL_PATCH_KEY] = true;
  }

  return state;
}

export function registerDenseHistoryEvents(
  pi: ExtensionAPI,
  state: DenseHistoryState,
) {
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    state.theme = ctx.ui.theme;
    state.activeTurn = false;
    state.touchedThinking.clear();
    state.touchedTools.clear();
    ctx.ui.setHiddenThinkingLabel("Reasoning · Ctrl+T to expand");
  });

  pi.on("agent_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (!state.activeTurn) {
      state.touchedThinking.clear();
      state.touchedTools.clear();
    }
    state.activeTurn = true;
  });

  pi.on("agent_settled", (_event, ctx) => {
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

export default async function (pi: ExtensionAPI) {
  const state = installDenseHistoryPatch(await loadHostPiModule());
  registerDenseHistoryEvents(pi, state);
}
