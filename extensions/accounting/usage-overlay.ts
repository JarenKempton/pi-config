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
  collectUsageStatus,
  formatAge,
  type UsageProviderStatus,
  type UsageStatusReport,
  type UsageWindow,
} from "./status.ts";

type OverlayState =
  | { phase: "loading" }
  | { phase: "ready"; report: UsageStatusReport }
  | { phase: "error"; message: string };

const SPINNER = ["◐", "◓", "◑", "◒"];
let overlayOpen = false;

function clampPercent(value: number | undefined) {
  return value === undefined ? undefined : Math.max(0, Math.min(100, value));
}

function durationLabel(minutes?: number) {
  if (!minutes) return undefined;
  if (minutes % 10_080 === 0) return `${minutes / 10_080}w window`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d window`;
  if (minutes % 60 === 0) return `${minutes / 60}h window`;
  return `${minutes}m window`;
}

function countdown(timestamp: number | undefined, now: number) {
  if (timestamp === undefined) return "reset unknown";
  const delta = timestamp - now;
  if (delta <= 0) return "reset due";
  const totalMinutes = Math.ceil(delta / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `resets in ${days}d${hours > 0 ? ` ${hours}h` : ""}`;
  if (hours > 0) return `resets in ${hours}h ${minutes}m`;
  return `resets in ${minutes}m`;
}

function percentColor(theme: Theme, percent: number | undefined) {
  if (percent === undefined) return (text: string) => theme.fg("muted", text);
  if (percent >= 85) return (text: string) => theme.fg("error", text);
  if (percent >= 60) return (text: string) => theme.fg("warning", text);
  return (text: string) => theme.fg("success", text);
}

function progressBar(theme: Theme, percent: number | undefined, width: number) {
  if (percent === undefined) return theme.fg("borderMuted", "░".repeat(width));
  const bounded = clampPercent(percent) ?? 0;
  const filled = Math.round((bounded / 100) * width);
  const color = percentColor(theme, bounded);
  return (
    color("█".repeat(filled)) +
    theme.fg("borderMuted", "░".repeat(Math.max(0, width - filled)))
  );
}

function windowLines(
  theme: Theme,
  window: UsageWindow,
  innerWidth: number,
  now: number,
) {
  const percent = clampPercent(window.usedPercent);
  const color = percentColor(theme, percent);
  const percentText =
    percent === undefined ? "unavailable" : `${Math.round(percent)}% used`;
  const duration = durationLabel(window.windowDurationMins);
  const label = duration ? `${window.label} · ${duration}` : window.label;
  const barWidth = Math.max(12, Math.min(32, innerWidth - 34));
  const remaining =
    percent === undefined ? "remaining unknown" : `${Math.round(100 - percent)}% left`;
  return [
    `  ${theme.fg("text", label)}  ${color(percentText)}`,
    `  ${progressBar(theme, percent, barWidth)}  ${theme.fg("muted", remaining)} · ${theme.fg("dim", countdown(window.resetsAt, now))}`,
  ];
}

function providerLines(
  theme: Theme,
  provider: UsageProviderStatus,
  innerWidth: number,
  now: number,
) {
  const observedMs = provider.observedAt
    ? Date.parse(provider.observedAt)
    : undefined;
  const age = formatAge(
    observedMs !== undefined && Number.isFinite(observedMs)
      ? Math.max(0, now - observedMs)
      : provider.ageMs,
  );
  const badge = provider.error
    ? theme.fg("error", "● unavailable")
    : provider.stale
      ? theme.fg("warning", "● stale")
      : theme.fg("success", "● current");
  const lines = [
    `${theme.bold(provider.label)}  ${badge}  ${theme.fg("dim", `${provider.source} · ${age}`)}`,
  ];
  if (provider.error) {
    lines.push(`  ${theme.fg("error", provider.error)}`);
    return lines;
  }
  if (!provider.windows.length) {
    lines.push(`  ${theme.fg("muted", "No quota windows reported")}`);
    return lines;
  }
  for (const window of provider.windows) {
    lines.push(...windowLines(theme, window, innerWidth, now));
  }
  return lines;
}

function padLine(value: string, width: number) {
  const truncated = truncateToWidth(value, width, "…");
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

export function renderUsageOverlay(
  state: OverlayState,
  theme: Theme,
  width: number,
  frame = 0,
  now = Date.now(),
): string[] {
  const panelWidth = Math.max(38, width);
  const innerWidth = panelWidth - 2;
  const row = (value = "") =>
    `${theme.fg("border", "│")}${padLine(value, innerWidth)}${theme.fg("border", "│")}`;
  const title = " Usage · subscription windows ";
  const titleWidth = Math.min(innerWidth, visibleWidth(title));
  const rightBorder = "─".repeat(Math.max(0, innerWidth - titleWidth));
  const lines = [
    `${theme.fg("border", "╭")}${theme.fg("accent", truncateToWidth(title, innerWidth, ""))}${theme.fg("border", `${rightBorder}╮`)}`,
  ];

  if (state.phase === "loading") {
    lines.push(
      row(""),
      row(
        `  ${theme.fg("accent", SPINNER[frame % SPINNER.length] ?? "◐")} ${theme.fg("text", "Reading live and cached quota windows…")}`,
      ),
      row(""),
    );
  } else if (state.phase === "error") {
    lines.push(
      row(""),
      row(`  ${theme.fg("error", "Unable to read usage")}`),
      row(`  ${theme.fg("muted", state.message)}`),
      row(""),
    );
  } else {
    lines.push(row(""));
    for (const provider of [state.report.codex, state.report.claude]) {
      for (const line of providerLines(theme, provider, innerWidth, now)) {
        lines.push(row(` ${line}`));
      }
      lines.push(row(""));
    }
  }

  lines.push(
    row(
      ` ${theme.fg("dim", "r refresh  ·  esc/q close")}`,
    ),
    `${theme.fg("border", "╰")}${theme.fg("border", "─".repeat(innerWidth))}${theme.fg("border", "╯")}`,
  );
  return lines;
}

class UsageOverlayComponent {
  private state: OverlayState = { phase: "loading" };
  private frame = 0;
  private disposed = false;
  private refreshing = false;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly done: () => void;
  private readonly load: () => Promise<UsageStatusReport>;

  constructor(
    tui: TUI,
    theme: Theme,
    done: () => void,
    load: () => Promise<UsageStatusReport>,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.load = load;
    this.timer = setInterval(() => {
      this.frame++;
      this.tui.requestRender();
    }, 500);
    void this.refresh();
  }

  private async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    this.state = { phase: "loading" };
    this.tui.requestRender();
    try {
      const report = await this.load();
      if (!this.disposed) this.state = { phase: "ready", report };
    } catch (error) {
      if (!this.disposed) {
        this.state = {
          phase: "error",
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
    }
  }

  render(width: number) {
    return renderUsageOverlay(this.state, this.theme, width, this.frame);
  }

  invalidate() {}

  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
  }
}

export async function showUsageOverlay(ctx: ExtensionContext) {
  if (overlayOpen) return;
  if (ctx.mode !== "tui") {
    const report = await collectUsageStatus();
    const windows = [...report.codex.windows, ...report.claude.windows];
    ctx.ui.notify(
      windows
        .map(
          (window) =>
            `${window.label}: ${window.usedPercent === undefined ? "n/a" : `${window.usedPercent}%`}`,
        )
        .join(" · ") || "No usage windows available",
      "info",
    );
    return;
  }

  overlayOpen = true;
  try {
    await ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) =>
        new UsageOverlayComponent(tui, theme, done, collectUsageStatus),
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: 76,
          minWidth: 48,
          maxHeight: "85%",
          margin: 1,
        },
      },
    );
  } finally {
    overlayOpen = false;
  }
}
