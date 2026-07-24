import type {
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  collectCostReport,
  type CostReport,
  type Period,
  type UsageRow,
} from "./cost.ts";

export type CostOverlayState =
  | { phase: "loading"; period: Period }
  | { phase: "ready"; report: CostReport }
  | { phase: "error"; period: Period; message: string };

const PERIODS: Period[] = ["today", "7d", "30d", "all"];
const SPINNER = ["◐", "◓", "◑", "◒"];
let overlayOpen = false;

function compactNumber(value: number) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}b`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return Math.round(value).toLocaleString();
}

function money(value: number) {
  if (value >= 100) return `$${value.toFixed(2)}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(4)}`;
}

function rowLabel(row: UsageRow) {
  const source = row.source === "Claude Code" ? "Claude" : row.source;
  return `${source} · ${row.model}`;
}

function padLine(value: string, width: number) {
  const truncated = truncateToWidth(value, width, "…");
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function cell(value: string, width: number, align: "left" | "right" = "right") {
  const truncated = truncateToWidth(value, width, "…");
  const padding = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
  return align === "left" ? `${truncated}${padding}` : `${padding}${truncated}`;
}

function periodTabs(theme: Theme, active: Period) {
  return PERIODS.map((period, index) => {
    const label = `${index + 1} ${period}`;
    return period === active
      ? theme.bg("selectedBg", theme.fg("accent", ` ${label} `))
      : theme.fg("dim", ` ${label} `);
  }).join(" ");
}

function costColor(theme: Theme, known: boolean) {
  return known
    ? (text: string) => theme.fg("success", text)
    : (text: string) => theme.fg("muted", text);
}

function costBar(theme: Theme, row: UsageRow, knownTotal: number, width: number) {
  if (!row.rateKnown || knownTotal <= 0) {
    return theme.fg("borderMuted", "░".repeat(width));
  }
  const share = Math.max(0, Math.min(1, row.apiEquivalentUsd / knownTotal));
  const filled = Math.max(row.apiEquivalentUsd > 0 ? 1 : 0, Math.round(share * width));
  return (
    theme.fg("accent", "█".repeat(filled)) +
    theme.fg("borderMuted", "░".repeat(Math.max(0, width - filled)))
  );
}

function detailRows(
  theme: Theme,
  report: CostReport,
  innerWidth: number,
): string[] {
  const rows = report.rows.filter(
    (row) => row.total > 0 || row.apiEquivalentUsd > 0,
  );
  const knownTotal = rows.reduce(
    (sum, row) => sum + (row.rateKnown ? row.apiEquivalentUsd : 0),
    0,
  );
  const lines: string[] = [];

  if (innerWidth >= 92) {
    const estimateWidth = 11;
    const turnsWidth = 7;
    const tokensWidth = 11;
    const cachedWidth = 11;
    const shareWidth = 14;
    const modelWidth = Math.max(
      24,
      innerWidth -
        estimateWidth -
        turnsWidth -
        tokensWidth -
        cachedWidth -
        shareWidth -
        14,
    );
    lines.push(
      theme.fg(
        "dim",
        `  ${cell("Source · model", modelWidth, "left")}  ${cell("Turns", turnsWidth)}  ${cell("Tokens", tokensWidth)}  ${cell("Cached", cachedWidth)}  ${cell("Share", shareWidth, "left")}  ${cell("Estimate", estimateWidth)}`,
      ),
    );
    for (const row of rows) {
      const estimate = row.rateKnown ? money(row.apiEquivalentUsd) : "n/a";
      lines.push(
        `  ${cell(rowLabel(row), modelWidth, "left")}  ${cell(compactNumber(row.turns), turnsWidth)}  ${cell(compactNumber(row.total), tokensWidth)}  ${cell(compactNumber(row.cacheRead), cachedWidth)}  ${costBar(theme, row, knownTotal, shareWidth)}  ${costColor(theme, row.rateKnown)(cell(estimate, estimateWidth))}`,
      );
    }
    return lines;
  }

  const barWidth = Math.max(10, Math.min(22, innerWidth - 48));
  for (const row of rows) {
    const estimate = row.rateKnown ? money(row.apiEquivalentUsd) : "n/a";
    lines.push(
      `  ${theme.fg("text", rowLabel(row))}  ${theme.fg("muted", `${compactNumber(row.total)} tok · ${compactNumber(row.turns)} turns`)}  ${costColor(theme, row.rateKnown)(estimate)}`,
      `  ${costBar(theme, row, knownTotal, barWidth)}  ${theme.fg("dim", row.rateKnown && knownTotal > 0 ? `${((row.apiEquivalentUsd / knownTotal) * 100).toFixed(1)}% of known estimate` : "rate unavailable")}`,
    );
  }
  return lines;
}

export function renderCostOverlay(
  state: CostOverlayState,
  theme: Theme,
  width: number,
  frame = 0,
): string[] {
  const panelWidth = Math.max(42, width);
  const innerWidth = panelWidth - 2;
  const row = (value = "") =>
    `${theme.fg("border", "│")}${padLine(value, innerWidth)}${theme.fg("border", "│")}`;
  const title = " Cost · API-equivalent history ";
  const titleWidth = Math.min(innerWidth, visibleWidth(title));
  const lines = [
    `${theme.fg("border", "╭")}${theme.fg("accent", truncateToWidth(title, innerWidth, ""))}${theme.fg("border", `${"─".repeat(Math.max(0, innerWidth - titleWidth))}╮`)}`,
    row(""),
    row(` ${periodTabs(theme, state.phase === "ready" ? state.report.period : state.period)}`),
    row(""),
  ];

  if (state.phase === "loading") {
    lines.push(
      row(
        `  ${theme.fg("accent", SPINNER[frame % SPINNER.length] ?? "◐")} ${theme.fg("text", `Reading ${state.period} local history…`)}`,
      ),
      row(""),
    );
  } else if (state.phase === "error") {
    lines.push(
      row(`  ${theme.fg("error", "Unable to compute cost history")}`),
      row(`  ${theme.fg("muted", state.message)}`),
      row(""),
    );
  } else {
    const report = state.report;
    const unknownRows = report.rows.filter(
      (entry) =>
        (entry.total > 0 || entry.apiEquivalentUsd > 0) && !entry.rateKnown,
    ).length;
    const totalLabel = report.total.rateKnown ? "estimated total" : "known subtotal";
    lines.push(
      row(
        ` ${theme.bold(money(report.total.apiEquivalentUsd))} ${theme.fg("muted", totalLabel)}  ·  ${theme.fg("text", compactNumber(report.total.total))} ${theme.fg("dim", "tokens")}  ·  ${theme.fg("text", compactNumber(report.total.turns))} ${theme.fg("dim", "turns")}`,
      ),
    );
    if (unknownRows > 0) {
      lines.push(
        row(
          ` ${theme.fg("warning", `${unknownRows} model${unknownRows === 1 ? "" : "s"} without a known rate`)}`,
        ),
      );
    }
    lines.push(row(""));
    for (const detail of detailRows(theme, report, innerWidth)) {
      lines.push(row(detail));
    }
    lines.push(row(""));
  }

  lines.push(
    row(` ${theme.fg("dim", "1–4 period  ·  r refresh  ·  esc/q close")}`),
    `${theme.fg("border", "╰")}${theme.fg("border", "─".repeat(innerWidth))}${theme.fg("border", "╯")}`,
  );
  return lines;
}

class CostOverlayComponent {
  private state: CostOverlayState;
  private frame = 0;
  private disposed = false;
  private refreshing = false;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly done: () => void;
  private readonly load: (period: Period) => Promise<CostReport>;

  constructor(
    tui: TUI,
    theme: Theme,
    done: () => void,
    initialPeriod: Period,
    load: (period: Period) => Promise<CostReport>,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.load = load;
    this.state = { phase: "loading", period: initialPeriod };
    this.timer = setInterval(() => {
      this.frame++;
      this.tui.requestRender();
    }, 500);
    void this.refresh(initialPeriod);
  }

  private currentPeriod() {
    return this.state.phase === "ready" ? this.state.report.period : this.state.period;
  }

  private async refresh(period = this.currentPeriod()) {
    if (this.refreshing) return;
    this.refreshing = true;
    this.state = { phase: "loading", period };
    this.tui.requestRender();
    try {
      const report = await this.load(period);
      if (!this.disposed) this.state = { phase: "ready", report };
    } catch (error) {
      if (!this.disposed) {
        this.state = {
          phase: "error",
          period,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
    this.refreshing = false;
    if (!this.disposed) this.tui.requestRender();
  }

  handleInput(data: string) {
    if (
      matchesKey(data, "escape") ||
      matchesKey(data, "ctrl+c") ||
      data.toLowerCase() === "q"
    ) {
      this.done();
      return;
    }
    if (data.toLowerCase() === "r" && !this.refreshing) {
      void this.refresh();
      return;
    }
    const selected = Number.parseInt(data, 10);
    if (selected >= 1 && selected <= PERIODS.length && !this.refreshing) {
      void this.refresh(PERIODS[selected - 1]);
    }
  }

  render(width: number) {
    return renderCostOverlay(this.state, this.theme, width, this.frame);
  }

  invalidate() {}

  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
  }
}

export async function showCostOverlay(
  ctx: ExtensionContext,
  initialPeriod: Period = "7d",
) {
  if (overlayOpen) return;
  if (ctx.mode !== "tui") {
    const report = await collectCostReport({ period: initialPeriod });
    ctx.ui.notify(
      `${initialPeriod}: ${money(report.total.apiEquivalentUsd)} ${report.total.rateKnown ? "estimated total" : "known subtotal"}`,
      "info",
    );
    return;
  }

  overlayOpen = true;
  try {
    await ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) =>
        new CostOverlayComponent(
          tui,
          theme,
          done,
          initialPeriod,
          (period) => collectCostReport({ period }),
        ),
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: 108,
          minWidth: 58,
          maxHeight: "88%",
          margin: 1,
        },
      },
    );
  } finally {
    overlayOpen = false;
  }
}
