import assert from "node:assert/strict";
import test from "node:test";
import { shouldConfirmEscape } from "../extensions/confirm-escape-abort.ts";

test("Escape requires confirmation only during an active agent run", () => {
  assert.equal(shouldConfirmEscape("\u001b", false, false), true);
  assert.equal(shouldConfirmEscape("\u001b", true, false), false);
  assert.equal(shouldConfirmEscape("enter", false, false), false);
});

test("Escape still dismisses autocomplete without showing abort confirmation", () => {
  assert.equal(shouldConfirmEscape("\u001b", false, true), false);
});
