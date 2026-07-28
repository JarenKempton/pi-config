import assert from "node:assert/strict";
import test from "node:test";
import {
  BTW_TITLE_MAX_LENGTH,
  buildBtwParentHandoff,
  buildBtwWorkerContract,
  deriveBtwTitle,
  isModelVisible,
} from "./src/by-the-way.ts";

test("deriveBtwTitle uses the first non-empty line and bounds the title", () => {
  assert.equal(
    deriveBtwTitle("\n   Why   does this work?   \nignore me"),
    "Why does this work?",
  );
  assert.equal(deriveBtwTitle(" \n\t"), "by the way");

  const title = deriveBtwTitle("x".repeat(BTW_TITLE_MAX_LENGTH + 10));
  assert.equal(title.length, BTW_TITLE_MAX_LENGTH);
  assert.equal(title, `${"x".repeat(BTW_TITLE_MAX_LENGTH - 1)}…`);

  const emojiTitle = deriveBtwTitle(
    `${"x".repeat(BTW_TITLE_MAX_LENGTH - 2)}😀 more`,
  );
  assert.equal(emojiTitle, `${"x".repeat(BTW_TITLE_MAX_LENGTH - 2)}😀…`);
});

test("BTW handoffs build explicit parent and worker context packets", () => {
  const contract = buildBtwWorkerContract("Fix the footer", "Use two rows");
  assert.match(contract, /## Original BTW request\nFix the footer/);
  assert.match(contract, /## Planner outcome\nUse two rows/);
  assert.match(contract, /verification performed/);

  assert.equal(
    buildBtwParentHandoff("Footer plan", "Use two rows"),
    "BTW handoff from “Footer plan” (explicitly queued by the user):\n\nUse two rows",
  );
});

test("only model-origin snapshots are visible to model-facing tools", () => {
  assert.equal(isModelVisible({ origin: "model" }), true);
  assert.equal(isModelVisible({ origin: "btw" }), false);
  assert.equal(isModelVisible({ origin: "wayfinder" }), false);
});
