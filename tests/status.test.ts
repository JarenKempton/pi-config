import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  parseClaudeUsageWindows,
  parseCodexUsageWindows,
  summarizeLimits,
  type UsageStatusReport,
} from "../extensions/accounting/status.ts";
import { renderUsageOverlay } from "../extensions/accounting/usage-overlay.ts";

test("usage status parses supported Claude quota windows", () => {
  const windows = parseClaudeUsageWindows({
    five_hour: { used_percentage: 21, resets_at: "2026-01-15T15:00:00Z" },
    seven_day: { used_percentage: 42, resets_at: "2026-01-20T00:00:00Z" },
  });
  assert.deepEqual(
    windows.map(({ id, label, usedPercent }) => ({ id, label, usedPercent })),
    [
      { id: "five-hour", label: "5-hour window", usedPercent: 21 },
      { id: "seven-day", label: "7-day window", usedPercent: 42 },
    ],
  );
  assert.match(summarizeLimits({ five_hour: { used_percentage: 21 } }), /21% used/);
});

test("usage status parses Codex rate-limit buckets", () => {
  const windows = parseCodexUsageWindows({
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        primary: {
          usedPercent: 50,
          windowDurationMins: 10_080,
          resetsAt: 1_800_000_000,
        },
      },
      spark: {
        limitName: "GPT Spark",
        primary: { usedPercent: 3 },
      },
    },
  });
  assert.equal(windows.length, 2);
  assert.deepEqual(
    windows.map(({ label, usedPercent }) => ({ label, usedPercent })),
    [
      { label: "codex", usedPercent: 50 },
      { label: "GPT Spark", usedPercent: 3 },
    ],
  );
});

test("usage overlay renders bounded progress bars", () => {
  const now = Date.parse("2026-07-24T17:05:00Z");
  const report: UsageStatusReport = {
    generatedAt: new Date(now).toISOString(),
    codex: {
      id: "codex",
      label: "Codex",
      source: "live account limits",
      observedAt: new Date(now - 2_000).toISOString(),
      stale: false,
      windows: [
        {
          id: "codex:primary",
          label: "Codex plan",
          usedPercent: 57,
          resetsAt: now + 3 * 86_400_000,
          windowDurationMins: 10_080,
        },
      ],
    },
    claude: {
      id: "claude",
      label: "Claude",
      source: "local status-line cache",
      observedAt: new Date(now - 26_000).toISOString(),
      stale: false,
      windows: [
        {
          id: "seven-day",
          label: "7-day window",
          usedPercent: 88,
          resetsAt: now + 23 * 3_600_000,
        },
      ],
    },
    cursor: {
      id: "cursor",
      label: "Cursor",
      source: "Team subscription · Gemini 3.6 Flash Minimal",
      observedAt: new Date(now - 1_000).toISOString(),
      stale: false,
      windows: [],
    },
  };
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme;
  const lines = renderUsageOverlay(
    { phase: "ready", report },
    theme,
    76,
    0,
    now,
  );
  assert.equal(lines.every((line) => visibleWidth(line) <= 76), true);
  assert.match(lines.join("\n"), /█/);
  assert.match(lines.join("\n"), /88% used/);
  assert.match(lines.join("\n"), /Cursor/);
  assert.match(lines.join("\n"), /Team subscription/);
  assert.match(lines.join("\n"), /No quota windows reported/);
  assert.match(lines.join("\n"), /esc\/q close/);
});
