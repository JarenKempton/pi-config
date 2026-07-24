import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { collectCostReport, renderCostReport } from "../extensions/accounting/cost.ts";
import { renderCostOverlay } from "../extensions/accounting/cost-overlay.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures/accounting");
const piFixtures = join(fixtures, "pi");
const codexFixtures = join(fixtures, "codex");
const claudeFixtures = join(fixtures, "claude");

test("collectCostReport parses Pi, Codex, and Claude fixtures deterministically", async () => {
  const report = await collectCostReport({
    period: "30d",
    now: new Date("2026-01-16T00:00:00.000Z"),
    roots: { pi: [piFixtures], codex: [codexFixtures], claude: [claudeFixtures] },
  });
  assert.equal(report.total.turns, 3);
  assert.equal(report.total.input, 1500);
  assert.equal(report.total.output, 2300);
  assert.equal(report.total.cacheRead, 420);
  assert.equal(report.total.cacheWrite, 10);
  assert.equal(report.total.reasoning, 50);
  assert.equal(report.skipped.pi, 1);
  assert.equal(report.rows.find((row) => row.source === "Claude Code")?.turns, 1);
  assert.equal(report.total.rateKnown, true);
  assert.match(renderCostReport(report), /API-equivalent estimate/);

  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme;
  const lines = renderCostOverlay({ phase: "ready", report }, theme, 108);
  assert.equal(lines.every((line) => visibleWidth(line) <= 108), true);
  assert.match(lines.join("\n"), /API-equivalent history/);
  assert.match(lines.join("\n"), /█/);
  assert.match(lines.join("\n"), /1–4 period/);
});
