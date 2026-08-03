import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  ACCOUNTING_INFO_CHANNEL,
  GIT_INFO_CHANNEL,
  MODEL_INFO_CHANNEL,
  type DashboardQuotaWindow,
} from "../vendor/davis/extensions/shared/dashboard-state.ts";
import uiCustomization, {
  formatMoney,
  formatQuotaCountdown,
  selectFooterQuotaWindows,
} from "../vendor/davis/extensions/ui-customization/index.ts";

function quota(
  provider: "Codex" | "Claude",
  id: string,
  windowDurationMins: number,
): DashboardQuotaWindow {
  return {
    provider,
    id,
    label: id,
    usedPercent: 25,
    resetsAt: Date.now() + 5 * 60 * 60_000,
    windowDurationMins,
    stale: false,
  };
}

test("footer money uses two decimal places", () => {
  assert.equal(formatMoney(0), "$0.00");
  assert.equal(formatMoney(1.236), "$1.24");
  assert.equal(formatMoney(123.4), "$123.40");
});

test("footer quota countdown stays compact", () => {
  const now = 1_000_000;
  assert.equal(formatQuotaCountdown(undefined, now), "?");
  assert.equal(formatQuotaCountdown(now, now), "now");
  assert.equal(formatQuotaCountdown(now + 45 * 60_000, now), "45m");
  assert.equal(formatQuotaCountdown(now + 5 * 60 * 60_000, now), "5h");
  assert.equal(
    formatQuotaCountdown(now + (2 * 24 + 3) * 60 * 60_000, now),
    "2d3h",
  );
});

test("footer hides weekly-only Codex buckets and restores Codex when 5h returns", () => {
  const weeklyOnly = [
    quota("Codex", "codex:primary", 10_080),
    quota("Codex", "codex-spark:primary", 10_080),
    quota("Claude", "five-hour", 300),
    quota("Claude", "seven-day", 10_080),
  ];
  assert.deepEqual(
    selectFooterQuotaWindows(weeklyOnly).map(({ provider, id }) => ({
      provider,
      id,
    })),
    [
      { provider: "Claude", id: "five-hour" },
      { provider: "Claude", id: "seven-day" },
    ],
  );

  const withCodexFiveHour = [quota("Codex", "five-hour", 300), ...weeklyOnly];
  assert.deepEqual(
    selectFooterQuotaWindows(withCodexFiveHour).map(({ provider, id }) => ({
      provider,
      id,
    })),
    [
      { provider: "Codex", id: "five-hour" },
      { provider: "Claude", id: "five-hour" },
      { provider: "Claude", id: "seven-day" },
    ],
  );
});

test("footer keeps stale quota context but hides expired current data", () => {
  const stale = quota("Claude", "five-hour", 300);
  stale.stale = true;
  stale.resetsAt = 1;
  const expired = quota("Claude", "seven-day", 10_080);
  expired.resetsAt = 1;
  assert.deepEqual(selectFooterQuotaWindows([stale, expired]), [stale]);
});

test("footer renders the compact repository and usage rows", async () => {
  const eventListeners = new Map<string, Array<(value: unknown) => void>>();
  const lifecycle = new Map<
    string,
    Array<(event: unknown, ctx: ExtensionContext) => void | Promise<void>>
  >();
  let footerFactory: any;
  const pi = {
    events: {
      on(channel: string, listener: (value: unknown) => void) {
        eventListeners.set(channel, [
          ...(eventListeners.get(channel) ?? []),
          listener,
        ]);
        return () => {};
      },
      emit(channel: string, value: unknown) {
        for (const listener of eventListeners.get(channel) ?? []) listener(value);
      },
    },
    on(
      name: string,
      listener: (event: unknown, ctx: ExtensionContext) => void | Promise<void>,
    ) {
      lifecycle.set(name, [...(lifecycle.get(name) ?? []), listener]);
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode: "tui",
    cwd: "/tmp/project",
    ui: {
      setHeader() {},
      setFooter(factory: unknown) {
        footerFactory = factory;
      },
      setTitle() {},
    },
  } as unknown as ExtensionContext;

  uiCustomization(pi);
  for (const listener of lifecycle.get("session_start") ?? []) {
    await listener({}, ctx);
  }
  pi.events.emit(MODEL_INFO_CHANNEL, {
    provider: "openai-codex",
    modelId: "gpt-5.6-sol",
    modelName: "GPT-5.6 Sol",
    thinking: "high",
    contextTokens: 10_000,
    contextWindow: 200_000,
    contextPercent: 5,
    cost: 1.236,
    tokensPerSecond: 50,
    generating: false,
  });
  pi.events.emit(GIT_INFO_CHANNEL, {
    isRepository: true,
    branch: "main",
    changedFiles: 3,
    pullRequest: null,
  });
  pi.events.emit(ACCOUNTING_INFO_CHANNEL, {
    todayCost: 12.345,
    todayRateKnown: true,
    quotaWindows: [
      quota("Codex", "codex:primary", 10_080),
      quota("Codex", "codex-spark:primary", 10_080),
      quota("Claude", "five-hour", 300),
      quota("Claude", "seven-day", 10_080),
    ],
    updatedAt: 1_000_000,
  });

  const theme = {
    fg: (_color: string, text: string) => text,
  } as Theme;
  const footer = footerFactory(
    { requestRender() {} },
    theme,
    { getExtensionStatuses: () => new Map() },
  );
  const lines = footer.render(160);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\/tmp\/project · main · 3 changed/);
  assert.match(lines[0], /gpt-5\.6-sol · high/);
  assert.match(lines[1], /ctx 5% · chat \$1\.24 · today \$12\.35/);
  assert.match(lines[1], /Claude · 5h 25%, resets in/);
  assert.doesNotMatch(lines[1], /Codex/);
  assert.doesNotMatch(lines[1], /[✦◎~↻]/);
  assert.equal(lines.every((line: string) => visibleWidth(line) <= 160), true);

  const staleFiveHour = quota("Claude", "five-hour", 300);
  staleFiveHour.stale = true;
  staleFiveHour.resetsAt = 1;
  const staleWeek = quota("Claude", "seven-day", 10_080);
  staleWeek.stale = true;
  staleWeek.resetsAt = 1;
  pi.events.emit(ACCOUNTING_INFO_CHANNEL, {
    todayCost: 12.345,
    todayRateKnown: true,
    quotaWindows: [staleFiveHour, staleWeek],
    updatedAt: 1_000_000,
  });
  const staleLines = footer.render(160);
  assert.match(staleLines[1], /Claude · stale · 5h 25% · week 25%/);
  assert.doesNotMatch(staleLines[1], /resets in/);
});
