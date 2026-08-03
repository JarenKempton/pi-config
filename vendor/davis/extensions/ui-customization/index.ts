import { homedir } from "node:os";
import { relative } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  getCapabilities,
  hyperlink,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  ACCOUNTING_INFO_CHANNEL,
  emptyAccountingInfoState,
  emptyGitInfoState,
  emptyModelInfoState,
  emptySubagentInfoState,
  GIT_INFO_CHANNEL,
  MODEL_INFO_CHANNEL,
  REFRESH_CHANNEL,
  SUBAGENT_INFO_CHANNEL,
  isAccountingInfoState,
  isGitInfoState,
  isModelInfoState,
  isSubagentInfoState,
  type DashboardQuotaWindow,
} from "../shared/dashboard-state.ts";

type Rgb = [number, number, number];
interface DashboardTui {
  requestRender(force?: boolean): void;
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const PALETTE: Rgb[] = [
  [22, 83, 189],
  [48, 129, 247],
  [93, 171, 255],
  [151, 205, 255],
  [93, 171, 255],
  [48, 129, 247],
];
const TITLE_LINES = [
  "  ██████╗  ██╗ ",
  "  ██╔══██╗ ██║ ",
  "  ██████╔╝ ██║ ",
  "  ██╔═══╝  ██║ ",
  "  ██║      ██║ ",
  "  ╚═╝      ╚═╝ ",
];
// eslint-disable-next-line no-control-regex
const OSC_PATTERN =
  /(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c)/g;
// eslint-disable-next-line no-control-regex
const CSI_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ESCAPE_PATTERN = /\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])/g;

function sanitizeTerminalLabel(text: string) {
  return text
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESCAPE_PATTERN, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

function mix(a: number, b: number, amount: number) {
  return Math.round(a + (b - a) * amount);
}

function sampleGradient(position: number) {
  const wrapped = ((position % 1) + 1) % 1;
  const scaled = wrapped * PALETTE.length;
  const index = Math.floor(scaled);
  const nextIndex = (index + 1) % PALETTE.length;
  const amount = scaled - index;
  const start = PALETTE[index]!;
  const end = PALETTE[nextIndex]!;

  return [
    mix(start[0], end[0], amount),
    mix(start[1], end[1], amount),
    mix(start[2], end[2], amount),
  ] satisfies Rgb;
}

function foreground([red, green, blue]: Rgb, text: string) {
  return `\x1b[38;2;${red};${green};${blue}m${text}${RESET}`;
}

function gradientText(text: string, phase: number) {
  const characters = [...text];
  const span = Math.max(characters.length - 1, 1);

  return characters
    .map((character, index) =>
      character === " "
        ? character
        : foreground(sampleGradient(index / span + phase), character),
    )
    .join("");
}

function formatDirectory(cwd: string) {
  const home = homedir();
  if (cwd === home) return "~";
  const display = cwd.startsWith(`${home}/`) ? `~/${relative(home, cwd)}` : cwd;
  return sanitizeTerminalLabel(display);
}

export function formatMoney(value: number) {
  return `$${value.toFixed(2)}`;
}

function isFiveHourWindow(window: DashboardQuotaWindow) {
  return window.windowDurationMins === 300 || window.id === "five-hour";
}

function isWeeklyWindow(window: DashboardQuotaWindow) {
  return window.windowDurationMins === 10_080 || window.id === "seven-day";
}

function quotaPeriod(window: DashboardQuotaWindow) {
  if (isFiveHourWindow(window)) return "5h";
  if (isWeeklyWindow(window)) return "week";
  if (window.windowDurationMins && window.windowDurationMins % 1_440 === 0) {
    return `${window.windowDurationMins / 1_440}d`;
  }
  return window.label.replace(/\s+window$/i, "");
}

export function formatQuotaCountdown(
  resetsAt: number | undefined,
  now = Date.now(),
) {
  if (resetsAt === undefined) return "?";
  const minutes = Math.ceil((resetsAt - now) / 60_000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return `${days}d${remainingHours ? `${remainingHours}h` : ""}`;
}

export function selectFooterQuotaWindows(windows: DashboardQuotaWindow[]) {
  const codex = windows.filter(
    (window) => window.provider === "Codex" && isFiveHourWindow(window),
  );
  const claude = windows
    .filter(
      (window) =>
        window.provider === "Claude" &&
        (isFiveHourWindow(window) || isWeeklyWindow(window)),
    )
    .sort((left, right) =>
      isFiveHourWindow(left) === isFiveHourWindow(right)
        ? 0
        : isFiveHourWindow(left)
          ? -1
          : 1,
    );
  return [...codex.slice(0, 1), ...claude.slice(0, 2)];
}

function quotaColor(usedPercent: number) {
  if (usedPercent >= 85) return "error";
  if (usedPercent >= 60) return "warning";
  return "success";
}

function formatQuotaWindows(
  windows: DashboardQuotaWindow[],
  theme: Theme,
  now = Date.now(),
) {
  const selected = selectFooterQuotaWindows(windows);
  const providers = ["Codex", "Claude"] as const;
  return providers
    .flatMap((provider) => {
      const providerWindows = selected.filter(
        (window) => window.provider === provider,
      );
      if (!providerWindows.length) return [];
      const icon = theme.fg(
        provider === "Codex" ? "success" : "warning",
        provider === "Codex" ? "◎" : "✦",
      );
      const values = providerWindows.map((window) => {
        const percent = `${Math.round(window.usedPercent)}%${window.stale ? "~" : ""}`;
        return [
          theme.fg("muted", quotaPeriod(window)),
          theme.fg(quotaColor(window.usedPercent), percent),
          theme.fg("dim", `↻${formatQuotaCountdown(window.resetsAt, now)}`),
        ].join(" ");
      });
      return [`${icon} ${values.join(" · ")}`];
    })
    .join("   ");
}

function center(text: string, width: number) {
  const padding = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
  return truncateToWidth(`${" ".repeat(padding)}${text}`, width);
}

function columns(left: string, right: string, width: number) {
  if (!right) return truncateToWidth(left, width);

  const naturalGap = width - visibleWidth(left) - visibleWidth(right);
  if (naturalGap >= 1) return `${left}${" ".repeat(naturalGap)}${right}`;

  const leftWidth = Math.max(1, Math.floor(width * 0.45));
  const rightWidth = Math.max(1, width - leftWidth - 1);
  const fittedLeft = truncateToWidth(left, leftWidth);
  const fittedRight = truncateToWidth(right, rightWidth);
  const gap = Math.max(
    1,
    width - visibleWidth(fittedLeft) - visibleWidth(fittedRight),
  );
  return truncateToWidth(
    `${fittedLeft}${" ".repeat(gap)}${fittedRight}`,
    width,
  );
}

export default function uiCustomization(pi: ExtensionAPI) {
  let title = "pi";
  let modelInfo = emptyModelInfoState();
  let gitInfo = emptyGitInfoState();
  let accountingInfo = emptyAccountingInfoState();
  let subagentInfo = emptySubagentInfoState();
  let requestRender: (() => void) | undefined;
  let activeTui: DashboardTui | undefined;

  const stopModelListener = pi.events.on(MODEL_INFO_CHANNEL, (value) => {
    if (!isModelInfoState(value)) return;
    modelInfo = value;
    requestRender?.();
  });

  const stopGitListener = pi.events.on(GIT_INFO_CHANNEL, (value) => {
    if (!isGitInfoState(value)) return;
    gitInfo = value;
    requestRender?.();
  });

  const stopAccountingListener = pi.events.on(ACCOUNTING_INFO_CHANNEL, (value) => {
    if (!isAccountingInfoState(value)) return;
    accountingInfo = value;
    requestRender?.();
  });

  const stopSubagentListener = pi.events.on(SUBAGENT_INFO_CHANNEL, (value) => {
    if (!isSubagentInfoState(value)) return;
    subagentInfo = value;
    requestRender?.();
  });

  function install(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;

    ctx.ui.setHeader((tui) => {
      activeTui = tui;
      requestRender = () => tui.requestRender();

      return {
        render(width: number) {
          const art = TITLE_LINES.map((line, row) =>
            center(gradientText(line, row * 0.045), width),
          );
          const subtitle = center(
            `${BOLD}${gradientText(title, 0.18)}${RESET}`,
            width,
          );
          return ["", ...art, subtitle, ""];
        },
        invalidate() {},
      };
    });

    ctx.ui.setFooter((tui, theme, footerData: ReadonlyFooterDataProvider) => {
      requestRender = () => tui.requestRender();

      return {
        invalidate() {},
        render(width: number) {
          const locationParts = [theme.fg("text", formatDirectory(ctx.cwd))];
          if (gitInfo.branch) {
            locationParts.push(theme.fg("muted", gitInfo.branch));
          }
          if (gitInfo.changedFiles > 0) {
            locationParts.push(
              theme.fg("muted", `${gitInfo.changedFiles} changed`),
            );
          }
          if (gitInfo.pullRequest) {
            const prLabel = `PR #${gitInfo.pullRequest.number}`;
            const linkedPr = getCapabilities().hyperlinks
              ? hyperlink(prLabel, gitInfo.pullRequest.url)
              : prLabel;
            locationParts.push(theme.fg("muted", linkedPr));
          }
          const location = locationParts.join(theme.fg("dim", " · "));

          const contextPercent =
            modelInfo.contextPercent === null
              ? "?"
              : `${Math.round(modelInfo.contextPercent)}`;
          const usageParts = [
            `ctx ${contextPercent}%`,
            `chat ${formatMoney(modelInfo.cost)}`,
          ];
          if (subagentInfo.count > 0) {
            usageParts.push(
              `agents ${subagentInfo.costKnown ? "" : "≥"}${formatMoney(subagentInfo.costUsd)}`,
            );
          }
          if (accountingInfo.todayCost !== null) {
            usageParts.push(
              `today ${accountingInfo.todayRateKnown ? "" : "≥"}${formatMoney(accountingInfo.todayCost)}`,
            );
          }
          const usage = usageParts.join(" · ");
          const quotas = formatQuotaWindows(accountingInfo.quotaWindows, theme);
          const model = modelInfo.thinking === "off"
            ? modelInfo.modelId
            : `${modelInfo.modelId} · ${modelInfo.thinking}`;

          const lines = [
            columns(location, theme.fg("muted", model), width),
            columns(theme.fg("muted", usage), quotas, width),
          ];

          // Extension statuses render after the dashboard lines, one per row.
          const statuses = footerData.getExtensionStatuses();
          const statusLines = Array.from(statuses.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .flatMap(([, text]) => text.split("\n"));
          for (const statusLine of statusLines) {
            lines.push(
              truncateToWidth(statusLine, width, theme.fg("dim", "...")),
            );
          }

          return lines;
        },
      };
    });

    ctx.ui.setTitle(`pi · ${title}`);
    pi.events.emit(REFRESH_CHANNEL, undefined);
  }

  pi.on("session_start", (_event, ctx) => {
    title = formatDirectory(ctx.cwd);
    modelInfo = emptyModelInfoState();
    gitInfo = emptyGitInfoState();
    accountingInfo = emptyAccountingInfoState();
    subagentInfo = emptySubagentInfoState();
    install(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopModelListener();
    stopGitListener();
    stopAccountingListener();
    stopSubagentListener();
    activeTui = undefined;
    requestRender = undefined;
    if (ctx.mode === "tui") {
      ctx.ui.setHeader(undefined);
      ctx.ui.setFooter(undefined);
    }
  });
}
