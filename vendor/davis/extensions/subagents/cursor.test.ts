import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import {
  cursorArgs,
  cursorPromptForProfile,
  mergeCursorAssistantText,
  parseCursorModels,
  parseCursorProtocolLine,
  terminateCursorProcess,
} from "./src/backends/cursor.ts";

test("Cursor profiles inject distinct read-only network policies", () => {
  const base = {
    prompt: "task",
    title: "task",
    cwd: "/repo",
    parent: { parentCwd: "/repo", projectTrusted: true },
  };
  assert.match(cursorPromptForProfile({ ...base, profile: "scout" }, "task"), /Do not access the web or network/);
  assert.match(cursorPromptForProfile({ ...base, profile: "researcher" }, "task"), /Web research is allowed/);
});

test("Cursor invocation pins plan mode, sandboxing, and workspace", () => {
  const task = {
    prompt: "task",
    title: "task",
    cwd: "/repo",
    profile: "scout" as const,
    parent: { parentCwd: "/repo", projectTrusted: true },
  };
  const args = cursorArgs(task, "inspect");
  assert.deepEqual(args.slice(args.indexOf("--mode"), args.indexOf("--mode") + 2), [
    "--mode",
    "plan",
  ]);
  assert.deepEqual(
    args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2),
    ["--sandbox", "enabled"],
  );
  assert.deepEqual(
    args.slice(args.indexOf("--workspace"), args.indexOf("--workspace") + 2),
    ["--workspace", "/repo"],
  );
});

test("Cursor assistant text keeps distinct blocks and deduplicates repeats", () => {
  assert.deepEqual(mergeCursorAssistantText("", "", "first"), {
    text: "first",
    changed: true,
  });
  assert.deepEqual(mergeCursorAssistantText("first", "first", "first"), {
    text: "first",
    changed: false,
  });
  assert.deepEqual(mergeCursorAssistantText("first", "first", "second"), {
    text: "first\nsecond",
    changed: true,
  });
  assert.deepEqual(mergeCursorAssistantText("first", "first", "first plus"), {
    text: "first plus",
    changed: true,
  });
});

test("Cursor model discovery parses the installed CLI catalog format", () => {
  assert.deepEqual(
    parseCursorModels(`Available models\n\nauto - Auto (current, default)\nkimi-k3-high - Kimi K3 High\nTip: use --model <id>`),
    [
      { id: "auto", label: "Auto (current, default)" },
      { id: "kimi-k3-high", label: "Kimi K3 High" },
    ],
  );
});

test("Cursor NDJSON parser normalizes the installed CLI protocol", () => {
  assert.deepEqual(
    parseCursorProtocolLine(
      JSON.stringify({ type: "system", subtype: "init", session_id: "chat-1", model: "Gemini 3.6 Flash Minimal" }),
    ),
    [{ type: "meta", sessionId: "chat-1", model: "Gemini 3.6 Flash Minimal" }],
  );
  assert.deepEqual(
    parseCursorProtocolLine(
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Finding" }] } }),
    ),
    [{ type: "assistant", text: "Finding", delta: false }],
  );
  assert.deepEqual(
    parseCursorProtocolLine(
      JSON.stringify({
        type: "tool_call",
        subtype: "started",
        call_id: "t1",
        tool_call: {
          readToolCall: { args: { path: "a.ts" } },
          toolCallId: "t1",
        },
      }),
    ),
    [{ type: "tool-start", id: "t1", name: "read", args: '{"path":"a.ts"}' }],
  );
  assert.deepEqual(
    parseCursorProtocolLine(
      JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        call_id: "t1",
        tool_call: {
          readToolCall: {
            args: { path: "a.ts" },
            result: { success: { content: "file contents" } },
          },
          toolCallId: "t1",
        },
      }),
    ),
    [{ type: "tool-end", id: "t1", name: "read", output: "file contents", isError: false }],
  );
  assert.deepEqual(
    parseCursorProtocolLine(
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "Done",
        usage: { inputTokens: 10, cacheReadTokens: 20, outputTokens: 3 },
      }),
    ),
    [
      { type: "usage", tokens: 33 },
      { type: "result", outcome: { _tag: "Completed", finalText: "Done" } },
    ],
  );
  const invalid = parseCursorProtocolLine("not-json")[0];
  assert.match(
    invalid?.type === "diagnostic" ? invalid.message : "",
    /Invalid Cursor protocol line/,
  );
});

test("Cursor process teardown terminates a headless process group", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const exited = once(child, "exit");
  await terminateCursorProcess(child);
  await exited;
  assert.notEqual(child.signalCode, null);
});
