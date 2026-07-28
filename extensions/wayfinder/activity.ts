import type {
  CockpitData,
  Ticket,
  WayfinderMap,
  WayfinderRun,
} from "./types.ts";

export type ActivityCategory =
  | "moving"
  | "needs-input"
  | "result-ready"
  | "failed"
  | "ready"
  | "waiting"
  | "resolved"
  | "archived";

export interface ActivityItem {
  id: string;
  category: ActivityCategory;
  map?: WayfinderMap;
  ticket?: Ticket;
  run?: WayfinderRun;
  title: string;
}

const CATEGORY_ORDER: ActivityCategory[] = [
  "moving",
  "needs-input",
  "result-ready",
  "failed",
  "ready",
  "waiting",
  "resolved",
  "archived",
];

function runCategory(run: WayfinderRun): ActivityCategory {
  if (run.status === "running") return "moving";
  if (run.status === "error") return "failed";
  if (run.status === "archived") return "archived";
  if (/needs? (human )?input|blocked on|waiting for/i.test(run.finalText ?? "")) {
    return "needs-input";
  }
  return "result-ready";
}

function ticketCategory(map: WayfinderMap, ticket: Ticket): ActivityCategory {
  if (map.state === "closed") {
    return ticket.trackerState === "resolved" ? "resolved" : "archived";
  }
  if (ticket.trackerState === "resolved") return "resolved";
  if (ticket.attention === "failed") return "failed";
  if (ticket.attention === "result") return "result-ready";
  if (
    ticket.trackerState === "migrated" ||
    ticket.attention === "needs-input" ||
    ticket.attention === "discovery"
  ) {
    return "needs-input";
  }
  const nativeStatus = ticket.trackerStatus?.toLowerCase() ?? "";
  if (
    ticket.blockedBy.length > 0 ||
    /blocked|impediment|waiting/.test(nativeStatus)
  ) return "waiting";
  if (ticket.source?.provider === "jira") {
    const category = ticket.trackerStatusCategory?.toLowerCase() ?? "";
    if (
      ticket.trackerState === "claimed" ||
      category.includes("progress") ||
      category === "indeterminate"
    ) return "needs-input";
    return "ready";
  }
  if (ticket.trackerState === "claimed") return "needs-input";
  return "ready";
}

export function buildActivityItems(data: CockpitData): ActivityItem[] {
  const mapsById = new Map(data.maps.map((map) => [map.id, map]));
  const ticketsByKey = new Map<string, { map: WayfinderMap; ticket: Ticket }>();
  for (const map of data.maps) {
    for (const ticket of map.tickets) {
      ticketsByKey.set(`${map.id}\0${ticket.id}`, { map, ticket });
    }
  }

  const latestRunByTicket = new Map<string, WayfinderRun>();
  const unlinkedRuns: WayfinderRun[] = [];
  for (const run of data.runs ?? []) {
    const key = `${run.mapId}\0${run.ticketId}`;
    if (!ticketsByKey.has(key)) {
      unlinkedRuns.push(run);
      continue;
    }
    const existing = latestRunByTicket.get(key);
    if (!existing || existing.updatedAt < run.updatedAt) {
      latestRunByTicket.set(key, run);
    }
  }

  const items: ActivityItem[] = [];
  for (const { map, ticket } of ticketsByKey.values()) {
    const run = latestRunByTicket.get(`${map.id}\0${ticket.id}`);
    items.push({
      id: run ? `run:${run.id}` : `ticket:${map.id}:${ticket.id}`,
      category:
        run && ticket.trackerState !== "resolved"
          ? runCategory(run)
          : ticketCategory(map, ticket),
      map,
      ticket,
      run,
      title: ticket.title,
    });
  }

  for (const run of unlinkedRuns) {
    const map = mapsById.get(run.mapId) ?? data.maps[0];
    items.push({
      id: `run:${run.id}`,
      category: runCategory(run),
      map,
      run,
      title: run.title,
    });
  }

  return items.sort((a, b) => {
    const categoryDifference =
      CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
    if (categoryDifference !== 0) return categoryDifference;
    const updatedDifference = (b.run?.updatedAt ?? 0) - (a.run?.updatedAt ?? 0);
    if (updatedDifference !== 0) return updatedDifference;
    return (a.ticket?.id ?? a.id).localeCompare(
      b.ticket?.id ?? b.id,
      undefined,
      { numeric: true },
    );
  });
}
