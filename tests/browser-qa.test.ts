import assert from "node:assert/strict";
import test from "node:test";
import { parseComputerUseResult } from "../extensions/browser-qa.ts";

test("browser QA validates Codex Computer Use JSON results", () => {
  const result = parseComputerUseResult(
    JSON.stringify({
      ok: true,
      final_message: "Checked the visible page.",
      images: ["/tmp/evidence.jpg"],
      approved_apps: ["Helium"],
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.final_message, "Checked the visible page.");
  assert.deepEqual(result.approved_apps, ["Helium"]);
  assert.throws(
    () => parseComputerUseResult(JSON.stringify({ final_message: "missing ok" })),
    /invalid result/,
  );
});
