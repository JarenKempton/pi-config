import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SUBAGENT_CONFIG } from "./src/config.ts";
import {
  reconcileDashboardSelection,
  SUBAGENT_MODAL_OPTIONS,
  SUBAGENT_TAKEOVER_OPTIONS,
  updateSubagentSetting,
  type DashboardSelection,
} from "./src/ui/takeover.ts";


test("subagent picker stays modal while takeover uses the full terminal", () => {
  assert.deepEqual(SUBAGENT_MODAL_OPTIONS, {
    anchor: "center",
    width: 112,
    minWidth: 58,
    maxHeight: "88%",
    margin: 1,
  });
  assert.deepEqual(SUBAGENT_TAKEOVER_OPTIONS, {
    anchor: "center",
    width: "100%",
    maxHeight: "100%",
  });
});

test("subagent settings update defaults and presets without mutating the source", () => {
  const source = structuredClone(DEFAULT_SUBAGENT_CONFIG);
  const changed = updateSubagentSetting(source, "default:cursor:model", "kimi-k3-max");
  const preset = updateSubagentSetting(changed, "preset:cursor-kimi:profile", "researcher");
  assert.equal(source.defaults.cursor.model, "auto");
  assert.equal(preset.defaults.cursor.model, "kimi-k3-max");
  assert.equal(preset.presets["cursor-kimi"]?.profile, "researcher");
  assert.equal(
    updateSubagentSetting(preset, "default:cursor:profile", "unrestricted")
      .defaults.cursor.profile,
    "scout",
  );
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
