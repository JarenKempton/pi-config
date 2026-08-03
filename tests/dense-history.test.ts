import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  installDenseHistoryPatch,
  renderCompactToolLine,
} from "../extensions/dense-history.ts";

const theme = {
  fg: (_color: string, text: string) => text,
} as Theme;

test("settled tool summaries preserve useful context in one line", () => {
  const [line] = renderCompactToolLine(
    {
      toolName: "bash",
      args: { command: "npm\ntest" },
      expanded: false,
      isPartial: false,
      result: {
        isError: false,
        content: [{ type: "text", text: "one\ntwo\nthree" }],
      },
      updateResult() {},
      render() {
        return [];
      },
    },
    theme,
    "ctrl+o",
    80,
  );

  assert.match(line, /^\$  npm test\s+3 lines  ⌃O$/);
  assert.equal(visibleWidth(line), 80);
});

test("dense history keeps live tools detailed and collapses settled tools", () => {
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
    toolName = "bash";
    args = { command: "npm test" };
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
  assert.match(
    historical.render(80)[0] ?? "",
    /^\$  npm test\s+1 line  ⌃O$/,
  );
  historical.expanded = true;
  assert.deepEqual(historical.render(80), ["FULL TOOL"]);

  state.activeTurn = true;
  const live = new FakeTool();
  live.updateResult(
    { content: [{ type: "text", text: "passed" }], isError: false },
    false,
  );
  assert.deepEqual(live.render(80), ["FULL TOOL"]);
  state.activeTurn = false;
  state.touchedTools.clear();
  assert.match(live.render(80)[0] ?? "", /^\$  npm test\s+1 line  ⌃O$/);
});

test("settled tool summaries stay bounded and expose errors", () => {
  const [line] = renderCompactToolLine(
    {
      toolName: "read",
      args: { path: `/tmp/${"nested/".repeat(30)}file.ts` },
      expanded: false,
      isPartial: false,
      result: {
        isError: true,
        content: [{ type: "text", text: "permission denied" }],
      },
      updateResult() {},
      render() {
        return [];
      },
    },
    theme,
    "ctrl+o",
    48,
  );

  assert.match(line, /^read  /);
  assert.match(line, /error  ⌃O$/);
  assert.equal(visibleWidth(line) <= 48, true);
});
