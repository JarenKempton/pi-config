import assert from "node:assert/strict";
import test from "node:test";
import type { SubagentSnapshot } from "./src/domain.ts";
import { transcriptToMarkdown } from "./src/ui/transcript.ts";

function snapshot(): SubagentSnapshot {
  return {
    id: "btw-1",
    origin: "btw",
    backend: "pi",
    title: "Plan footer work",
    prompt: "Plan the footer",
    cwd: "/repo",
    profile: "scout",
    status: "done",
    createdAt: 1,
    settledAt: 2,
    meta: { backend: "pi" },
    usage: { costKnown: true },
    transcript: [
      { kind: "user", text: "Plan the footer" },
      {
        kind: "assistant",
        parts: [
          { type: "thinking", text: "private chain of thought" },
          { type: "text", text: "Use a compact two-row layout." },
          { type: "toolCall", toolId: "t1", name: "read", argsPreview: "footer.ts" },
        ],
      },
      {
        kind: "toolResult",
        toolId: "t1",
        name: "read",
        isError: false,
        outputPreview: "current footer",
      },
    ],
    liveTools: [],
    queued: [],
    finalText: "Use a compact two-row layout.",
    turns: 1,
  };
}

test("clipboard transcript is readable Markdown and omits hidden reasoning", () => {
  const markdown = transcriptToMarkdown(snapshot());
  assert.match(markdown, /^# Plan footer work/);
  assert.match(markdown, /## User\n\nPlan the footer/);
  assert.match(markdown, /Use a compact two-row layout/);
  assert.match(markdown, /_Tool: read — footer\.ts_/);
  assert.match(markdown, /## Tool result\n\ncurrent footer/);
  assert.doesNotMatch(markdown, /private chain of thought/);
});
