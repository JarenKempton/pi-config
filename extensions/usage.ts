import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ACCOUNTING_INFO_CHANNEL,
  type AccountingInfoState,
} from "../vendor/davis/extensions/shared/dashboard-state.ts";
import { showCostOverlay } from "./accounting/cost-overlay.ts";
import { collectCostReport, type Period } from "./accounting/cost.ts";
import { collectUsageStatus, type UsageStatusReport } from "./accounting/status.ts";
import { showUsageOverlay } from "./accounting/usage-overlay.ts";

const DASHBOARD_REFRESH_MS = 5 * 60 * 1000;

function parsePeriod(args: string): Period {
  const value = args.trim().toLowerCase() || "7d";
  if (
    value === "today" ||
    value === "7d" ||
    value === "30d" ||
    value === "all"
  ) {
    return value;
  }
  throw new Error("Usage: /cost [today|7d|30d|all]");
}

export default function (pi: ExtensionAPI) {
  let dashboardTimer: ReturnType<typeof setInterval> | undefined;
  let dashboardRefreshRunning = false;
  let lastUsageReport: UsageStatusReport | undefined;
  let lastUsageRefresh = 0;

  const refreshDashboard = async (forceUsage = false) => {
    if (dashboardRefreshRunning) return;
    dashboardRefreshRunning = true;
    try {
      const refreshUsage =
        forceUsage ||
        !lastUsageReport ||
        Date.now() - lastUsageRefresh >= DASHBOARD_REFRESH_MS;
      const [costReport, usageReport] = await Promise.all([
        collectCostReport({ period: "today" }),
        refreshUsage ? collectUsageStatus() : Promise.resolve(lastUsageReport),
      ]);
      if (usageReport) {
        lastUsageReport = usageReport;
        if (refreshUsage) lastUsageRefresh = Date.now();
      }
      const quotaWindows: AccountingInfoState["quotaWindows"] = lastUsageReport
        ? [lastUsageReport.codex, lastUsageReport.claude].flatMap((provider) =>
            provider.windows.flatMap((window) =>
              window.usedPercent === undefined
                ? []
                : [
                    {
                      provider: provider.id === "codex" ? "Codex" : "Claude",
                      id: window.id,
                      label: window.label,
                      usedPercent: window.usedPercent,
                      windowDurationMins: window.windowDurationMins,
                      stale: provider.stale,
                    },
                  ],
            ),
          )
        : [];
      pi.events.emit(ACCOUNTING_INFO_CHANNEL, {
        todayCost: costReport.total.apiEquivalentUsd,
        todayRateKnown: costReport.total.rateKnown,
        quotaWindows,
        updatedAt: Date.now(),
      } satisfies AccountingInfoState);
    } catch {
      // Footer accounting is best-effort; /usage and /cost retain full errors.
    } finally {
      dashboardRefreshRunning = false;
    }
  };

  pi.on("session_start", () => {
    if (dashboardTimer) clearInterval(dashboardTimer);
    void refreshDashboard(true);
    dashboardTimer = setInterval(() => void refreshDashboard(true), DASHBOARD_REFRESH_MS);
    dashboardTimer.unref?.();
  });

  pi.on("agent_settled", () => {
    void refreshDashboard(false);
  });

  pi.on("session_shutdown", () => {
    if (dashboardTimer) clearInterval(dashboardTimer);
    dashboardTimer = undefined;
  });

  const openUsage = async (ctx: Parameters<typeof showUsageOverlay>[0]) => {
    try {
      await showUsageOverlay(ctx);
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    }
  };
  const openCost = async (
    ctx: Parameters<typeof showCostOverlay>[0],
    period: Period = "7d",
  ) => {
    try {
      await showCostOverlay(ctx, period);
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    }
  };

  pi.registerCommand("usage", {
    description:
      "Open live Codex and cached Claude quota windows in a TUI overlay",
    handler: async (_args, ctx) => openUsage(ctx),
  });

  pi.registerShortcut("alt+u", {
    description: "Open usage quota overlay",
    handler: openUsage,
  });

  pi.registerCommand("cost", {
    description:
      "Open local Pi, Claude, and Codex API-equivalent history in a TUI overlay (today|7d|30d|all)",
    handler: async (args, ctx) => openCost(ctx, parsePeriod(args)),
  });

  pi.registerShortcut("alt+c", {
    description: "Open seven-day cost overlay",
    handler: (ctx) => openCost(ctx),
  });
}
