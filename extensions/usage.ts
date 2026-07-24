import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Period } from "./accounting/cost.ts";
import { showCostOverlay } from "./accounting/cost-overlay.ts";
import { showUsageOverlay } from "./accounting/usage-overlay.ts";

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
