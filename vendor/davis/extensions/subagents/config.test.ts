import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SUBAGENT_CONFIG,
  parseSubagentConfig,
  resolveSpawnConfig,
  serializeSubagentConfig,
} from "./src/config.ts";

test("subagent config validates unknown values and retains safe defaults", () => {
  const config = parseSubagentConfig({
    defaultHarness: "invalid",
    defaults: {
      cursor: { model: "kimi-k3-high", profile: "worker" },
      codex: { reasoningEffort: "impossible" },
    },
    presets: {
      good: { harness: "cursor", model: "gemini-3.6-flash-high", profile: "researcher" },
      bad: { harness: "unknown", model: "x" },
    },
  });
  assert.equal(config.defaultHarness, "pi");
  assert.equal(config.defaults.cursor.model, "kimi-k3-high");
  assert.equal(config.defaults.cursor.profile, "scout");
  assert.equal(config.defaults.codex.reasoningEffort, "high");
  assert.equal(config.defaults.claude.model, "fable");
  assert.equal(config.defaults.claude.reasoningEffort, "high");
  assert.deepEqual(Object.keys(config.presets), ["good"]);
});

test("native model and inherited effort survive a serialized config round trip", () => {
  const config = structuredClone(DEFAULT_SUBAGENT_CONFIG);
  config.defaults.claude = { profile: "scout" };
  const reparsed = parseSubagentConfig(
    JSON.parse(serializeSubagentConfig(config)) as unknown,
  );
  assert.deepEqual(reparsed.defaults.claude, { profile: "scout" });
  assert.equal(resolveSpawnConfig(reparsed, { harness: "claude" }).model, undefined);
  assert.equal(
    resolveSpawnConfig(reparsed, { harness: "claude" }).reasoningEffort,
    undefined,
  );
});

test("spawn configuration precedence is explicit then preset then harness default", () => {
  const config = structuredClone(DEFAULT_SUBAGENT_CONFIG);
  assert.deepEqual(resolveSpawnConfig(config, { preset: "cursor-kimi" }), {
    harness: "cursor",
    preset: "cursor-kimi",
    model: "kimi-k3-high",
    reasoningEffort: undefined,
    profile: "scout",
  });
  assert.deepEqual(
    resolveSpawnConfig(config, {
      preset: "cursor-kimi",
      model: "kimi-k3-max",
      profile: "researcher",
    }),
    {
      harness: "cursor",
      preset: "cursor-kimi",
      model: "kimi-k3-max",
      reasoningEffort: undefined,
      profile: "researcher",
    },
  );
  assert.throws(
    () => resolveSpawnConfig(config, { preset: "missing" }),
    /Unknown subagent preset/,
  );
  assert.throws(
    () => resolveSpawnConfig(config, { preset: "cursor-kimi", harness: "codex" }),
    /uses cursor, but explicit harness codex/,
  );
});
