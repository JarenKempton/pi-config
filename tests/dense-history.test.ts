import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  installDenseHistoryPatch,
  registerDenseHistoryEvents,
} from "../extensions/dense-history.ts";

const theme = {
  fg: (_color: string, text: string) => text,
} as Theme;

test("dense history keeps active tools detailed and hides settled tools", () => {
  class FakeAssistant {
    hideThinkingBlock = true;
    setHideThinkingBlock(hidden: boolean) {
      this.hideThinkingBlock = hidden;
    }
    updateContent() {}
  }
  class FakeCompaction {
    expanded = false;
    message = { tokensBefore: 10_000 };
    render() {
      return ["FULL COMPACTION"];
    }
  }
  class FakeTool {
    expanded = false;
    isPartial = true;
    result?: {
      content: Array<{ type: string; text?: string }>;
      isError: boolean;
    };
    updateResult(result: typeof this.result, isPartial = false) {
      this.result = result;
      this.isPartial = isPartial;
    }
    render(_width?: number) {
      return ["FULL TOOL"];
    }
  }

  const state = installDenseHistoryPatch({
    AssistantMessageComponent: { prototype: FakeAssistant.prototype },
    CompactionSummaryMessageComponent: { prototype: FakeCompaction.prototype },
    ToolExecutionComponent: { prototype: FakeTool.prototype },
    keyText: () => "ctrl+o",
  } as any);
  state.theme = theme;

  const historical = new FakeTool();
  historical.updateResult(
    { content: [{ type: "text", text: "passed" }], isError: false },
    false,
  );
  assert.deepEqual(historical.render(80), []);
  historical.expanded = true;
  assert.deepEqual(historical.render(80), ["FULL TOOL"]);

  state.activeTurn = true;
  const live = new FakeTool();
  live.updateResult(
    { content: [{ type: "text", text: "passed" }], isError: false },
    false,
  );
  assert.deepEqual(live.render(80), ["FULL TOOL"]);

  // Internal model/tool turns do not clear touchedTools. Only agent_settled does.
  assert.deepEqual(live.render(80), ["FULL TOOL"]);
  state.activeTurn = false;
  state.touchedTools.clear();
  assert.deepEqual(live.render(80), []);

  live.expanded = true;
  assert.deepEqual(live.render(80), ["FULL TOOL"]);
});

test("dense history collapses at agent settlement, not internal turn boundaries", async () => {
  const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
  const pi = {
    on(name: string, handler: (event: unknown, ctx: any) => unknown) {
      handlers.set(name, handler);
    },
  };
  let hidden = false;
  const thinking = {
    hideThinkingBlock: false,
    setHideThinkingBlock(value: boolean) {
      hidden = value;
    },
    updateContent() {},
  };
  const tool = {};
  const state = {
    activeTurn: false,
    theme,
    touchedThinking: new Set<any>(),
    touchedTools: new Set<any>(),
  };
  registerDenseHistoryEvents(pi as any, state as any);

  assert.equal(handlers.has("turn_end"), false);
  assert.equal(handlers.has("agent_start"), true);
  assert.equal(handlers.has("agent_settled"), true);

  const ctx = {
    mode: "tui",
    ui: {
      theme,
      setHiddenThinkingLabel() {},
    },
  };
  await handlers.get("agent_start")?.({}, ctx);
  assert.equal(state.activeTurn, true);
  state.touchedThinking.add(thinking);
  state.touchedTools.add(tool);

  // A subsequent low-level start in the same response must preserve history.
  await handlers.get("agent_start")?.({}, ctx);
  assert.equal(state.touchedThinking.size, 1);
  assert.equal(state.touchedTools.size, 1);

  await handlers.get("agent_settled")?.({}, ctx);
  assert.equal(state.activeTurn, false);
  assert.equal(hidden, true);
  assert.equal(state.touchedThinking.size, 0);
  assert.equal(state.touchedTools.size, 0);
});
