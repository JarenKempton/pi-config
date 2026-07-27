import assert from "node:assert/strict";
import test from "node:test";
import {
  reconcileDashboardSelection,
  SUBAGENT_MODAL_OPTIONS,
  type DashboardSelection,
} from "./src/ui/takeover.ts";


test("subagent dashboards use a bounded centered modal", () => {
  assert.deepEqual(SUBAGENT_MODAL_OPTIONS, {
    anchor: "center",
    width: 112,
    minWidth: 58,
    maxHeight: "88%",
    margin: 1,
  });
});

test("dashboard selection follows its subagent id and falls back by row", () => {
  const selection: DashboardSelection = { id: "sa-7", index: 6 };

  reconcileDashboardSelection(selection, [
    { id: "sa-new" },
    ...Array.from({ length: 8 }, (_, index) => ({ id: `sa-${index + 1}` })),
  ]);
  assert.deepEqual(selection, { id: "sa-7", index: 7 });

  reconcileDashboardSelection(selection, [
    ...Array.from({ length: 6 }, (_, index) => ({ id: `sa-${index + 1}` })),
    { id: "sa-8" },
    { id: "sa-9" },
  ]);
  assert.deepEqual(selection, { id: "sa-9", index: 7 });

  reconcileDashboardSelection(selection, [{ id: "sa-1" }, { id: "sa-2" }]);
  assert.deepEqual(selection, { id: "sa-2", index: 1 });

  reconcileDashboardSelection(selection, []);
  assert.deepEqual(selection, { id: undefined, index: 0 });
});
