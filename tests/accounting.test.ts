import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { collectCostReport, renderCostReport } from "../extensions/accounting/cost.ts";
import { renderCostOverlay } from "../extensions/accounting/cost-overlay.ts";
import {
  FALLBACK_RATES,
  loadPricingCatalog,
  parseAnthropicPricing,
  parseOpenAiPricing,
} from "../extensions/accounting/pricing.ts";

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
    pricingCatalog: {
      rates: new Map(Object.entries(FALLBACK_RATES)),
      live: false,
      notes: ["test pricing"],
    },
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

test("official pricing parsers discover new OpenAI and Anthropic models", () => {
  const openai = parseOpenAiPricing(`
### Standard pricing data
| Model | Short context input | Short context cached input | Short context cache writes | Short context output |
| --- | --- | --- | --- | --- |
| gpt-5.6-sol | $5.00 | $0.50 | $6.25 | $30.00 |
### Batch pricing data
`);
  assert.deepEqual(openai.get("gpt-5-6-sol"), {
    input: 5,
    output: 30,
    cacheRead: 0.5,
    cacheWrite5m: 6.25,
    cacheWrite1h: 6.25,
  });

  const anthropic = parseAnthropicPricing(`
| Model | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes | Output Tokens |
| --- | --- | --- | --- | --- | --- |
| Claude Opus 5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
| Claude Sonnet 5 through August 31, 2026 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |
| Claude Sonnet 5 starting September 1, 2026 | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |
`, new Date("2026-08-03T00:00:00Z"));
  assert.equal(anthropic.get("claude-opus-5")?.output, 25);
  assert.equal(anthropic.get("claude-sonnet-5")?.input, 2);
});

test("pricing catalog refreshes both official sources and writes an atomic cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-pricing-test-"));
  const cachePath = join(directory, "pricing.json");
  const requests: string[] = [];
  const openai = `
### Standard pricing data
| Model | Input | Cached input | Cache writes | Output |
| --- | --- | --- | --- | --- |
| gpt-5.6-sol | $5.00 | $0.50 | $6.25 | $30.00 |
### Batch pricing data
`;
  const anthropic = `
| Model | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes | Output Tokens |
| --- | --- | --- | --- | --- | --- |
| Claude Opus 5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
`;

  try {
    const catalog = await loadPricingCatalog({
      forceRefresh: true,
      cachePath,
      now: new Date("2026-08-03T00:00:00Z"),
      fetchFn: async (input) => {
        const url = String(input);
        requests.push(url);
        return new Response(url.includes("openai") ? openai : anthropic);
      },
    });
    assert.equal(requests.length, 2);
    assert.equal(catalog.live, true);
    assert.equal(catalog.rates.get("claude-opus-5")?.output, 25);
    const cached = JSON.parse(await readFile(cachePath, "utf8"));
    assert.deepEqual(cached.providers, ["OpenAI", "Anthropic"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
