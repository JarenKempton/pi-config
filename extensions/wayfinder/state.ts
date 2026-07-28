import { buildActivityItems } from "./activity.ts";
import type {
  CockpitData,
  RoutingRule,
  Ticket,
  WayfinderMap,
} from "./types.ts";

export type MapVariant = 1 | 2 | 3;
export type Screen =
  | "maps"
  | "map"
  | "ticket"
  | "map-context"
  | "attention"
  | "agents"
  | "settings"
  | "delivery-settings"
  | "agent-settings"
  | "routing-settings"
  | "tracker-settings"
  | "automation-settings"
  | "agent-editor"
  | "rule-editor"
  | "simulator";

export interface CockpitState {
  screen: Screen;
  mapIndex: number;
  selectedTicketId: string;
  variant: MapVariant;
  attentionIndex: number;
  agentIndex: number;
  agentsReturn: "maps" | "map" | "ticket" | "map-context";
  discoveryDecisions: Record<string, "accepted" | "fog" | "dismissed">;
  settingsIndex: number;
  settingsReturn: "maps" | "map" | "ticket" | "map-context";
  trackerIndex: number;
  jiraBoardIndex: number;
  ruleIndex: number;
  agentDefaultIndex: number;
  automationIndex: number;
  ruleField: number;
  draftRule?: RoutingRule;
  simulatorIndex: number;
  deliveryProfileIndex: number;
  deliveryCursor: number;
  scrollOffset: number;
  notice?: string;
}

export type CockpitAction =
  | { type: "up" }
  | { type: "down" }
  | { type: "left" }
  | { type: "right" }
  | { type: "page-up" }
  | { type: "page-down" }
  | { type: "enter" }
  | { type: "back" }
  | { type: "show-maps" }
  | { type: "show-attention" }
  | { type: "show-agents" }
  | { type: "show-settings" }
  | { type: "show-context" }
  | { type: "set-variant"; variant: MapVariant }
  | { type: "decide-discovery"; decision: "accepted" | "fog" | "dismissed" };

export function presentationState(ticket: Ticket) {
  if (ticket.trackerState === "migrated") return "attention" as const;
  if (ticket.trackerState === "resolved") return "resolved" as const;
  if (ticket.attention) return "attention" as const;
  const nativeStatus = ticket.trackerStatus?.toLowerCase() ?? "";
  // Jira status is authoritative. An assignee is ownership, not proof that a
  // To Do item is in flight, and a native Blocked status must remain visible
  // even when a link is temporarily missing.
  if (/blocked|impediment|waiting/.test(nativeStatus)) return "blocked" as const;
  if (ticket.blockedBy.length > 0) return "blocked" as const;
  if (
    ticket.review?.state === "review-required" ||
    ticket.review?.state === "changes-requested" ||
    ticket.review?.state === "approved"
  ) {
    return "waiting" as const;
  }
  if (ticket.source?.provider === "jira") {
    const category = ticket.trackerStatusCategory?.toLowerCase() ?? "";
    if (
      ticket.trackerState === "claimed" ||
      category.includes("progress") ||
      category === "indeterminate" ||
      /in progress|review|testing|implementing|active/.test(nativeStatus) ||
      ticket.agent
    ) {
      return "in-flight" as const;
    }
    return "frontier" as const;
  }
  if (
    ticket.trackerState === "claimed" ||
    ticket.agent ||
    ticket.workspace ||
    ticket.review
  ) {
    return "in-flight" as const;
  }
  return "frontier" as const;
}

const STATE_ORDER = [
  "frontier",
  "in-flight",
  "attention",
  "waiting",
  "blocked",
  "resolved",
] as const;

export function ledgerTickets(map: WayfinderMap) {
  return [...map.tickets].sort((a, b) => {
    const stateDifference =
      STATE_ORDER.indexOf(presentationState(a)) -
      STATE_ORDER.indexOf(presentationState(b));
    if (stateDifference !== 0) return stateDifference;
    return a.id.localeCompare(b.id, undefined, { numeric: true });
  });
}

export function dependencyTickets(map: WayfinderMap) {
  const byId = new Map(map.tickets.map((ticket) => [ticket.id, ticket]));
  const children = new Map<string, Ticket[]>();
  for (const ticket of map.tickets) {
    for (const blocker of ticket.blockedBy) {
      const list = children.get(blocker) ?? [];
      list.push(ticket);
      children.set(blocker, list);
    }
  }

  const result: Array<{ ticket: Ticket; depth: number }> = [];
  const visited = new Set<string>();
  const visit = (ticket: Ticket, depth: number) => {
    if (visited.has(ticket.id)) return;
    visited.add(ticket.id);
    result.push({ ticket, depth });
    for (const child of children.get(ticket.id) ?? []) visit(child, depth + 1);
  };

  for (const ticket of map.tickets.filter((item) => item.blockedBy.length === 0)) {
    visit(ticket, 0);
  }
  for (const ticket of map.tickets) visit(ticket, 0);

  return result.filter(({ ticket }) => byId.has(ticket.id));
}

export function visibleTickets(map: WayfinderMap, variant: MapVariant) {
  if (variant === 2) return dependencyTickets(map).map(({ ticket }) => ticket);
  if (variant === 3) {
    return [...map.tickets].sort((a, b) => {
      const aActive = presentationState(a) === "frontier" ? 0 : 1;
      const bActive = presentationState(b) === "frontier" ? 0 : 1;
      return aActive - bActive || a.id.localeCompare(b.id, undefined, { numeric: true });
    });
  }
  return ledgerTickets(map);
}

export function selectedMap(state: CockpitState, data: CockpitData) {
  return data.maps[state.mapIndex] ?? data.maps[0]!;
}

export function selectedTicket(state: CockpitState, data: CockpitData) {
  const map = selectedMap(state, data);
  return (
    map.tickets.find((ticket) => ticket.id === state.selectedTicketId) ??
    visibleTickets(map, state.variant)[0]!
  );
}

export function initialState(data: CockpitData): CockpitState {
  const initialMap = data.maps[0];
  const configuredDeliveryIndex = data.deliveryProfiles.findIndex(
    (profile) => profile.id === data.configuredDeliveryProfileId,
  );
  const deliveryProfileIndex = Math.max(
    0,
    configuredDeliveryIndex >= 0
      ? configuredDeliveryIndex
      : data.deliveryProfiles.findIndex(
          (profile) => profile.outcome === initialMap?.outcome,
        ),
  );
  return {
    screen: "maps",
    mapIndex: 0,
    selectedTicketId: initialMap ? ledgerTickets(initialMap)[0]?.id ?? "" : "",
    variant: 1,
    attentionIndex: 0,
    agentIndex: 0,
    agentsReturn: "maps",
    discoveryDecisions: {},
    settingsIndex: 0,
    settingsReturn: "maps",
    trackerIndex: Math.max(
      0,
      data.trackers.findIndex((tracker) => tracker.id === data.configuredTrackerId),
    ),
    jiraBoardIndex: Math.max(
      0,
      data.jiraBoards?.findIndex(
        (board) => board.id === data.configuredJiraBoardId,
      ) ?? 0,
    ),
    ruleIndex: 0,
    agentDefaultIndex: 0,
    automationIndex: 0,
    ruleField: 0,
    simulatorIndex: 0,
    deliveryProfileIndex,
    deliveryCursor: deliveryProfileIndex,
    scrollOffset: 0,
  };
}

function move(value: number, delta: number, length: number) {
  if (length <= 0) return 0;
  return (value + delta + length) % length;
}

function moveTicket(
  state: CockpitState,
  data: CockpitData,
  delta: number,
): CockpitState {
  const tickets = visibleTickets(selectedMap(state, data), state.variant);
  const current = Math.max(
    0,
    tickets.findIndex((ticket) => ticket.id === state.selectedTicketId),
  );
  const selected = tickets[move(current, delta, tickets.length)];
  return { ...state, selectedTicketId: selected?.id ?? state.selectedTicketId };
}

const PROFILES: RoutingRule["profile"][] = ["scout", "researcher", "worker"];

function normalizeRuleTarget(rule: RoutingRule, data: CockpitData): RoutingRule {
  const runtimes = data.agentCatalog.filter((runtime) => runtime.models.length > 0);
  const runtime =
    runtimes.find((candidate) => candidate.id === rule.runtime) ?? runtimes[0];
  if (!runtime) return rule;
  const model =
    runtime.models.find(
      (candidate) =>
        candidate.id.toLowerCase() === rule.model.toLowerCase() ||
        candidate.label.toLowerCase() === rule.model.toLowerCase(),
    ) ?? runtime.models[0]!;
  const effort = model.efforts.includes(rule.effort)
    ? rule.effort
    : model.defaultEffort;
  return { ...rule, runtime: runtime.id, model: model.id, effort };
}

function cycleDraftRule(
  state: CockpitState,
  data: CockpitData,
  delta: number,
): CockpitState {
  const draft = state.draftRule;
  if (!draft) return state;
  const cycle = <T>(items: T[], current: T) =>
    items[move(Math.max(0, items.indexOf(current)), delta, items.length)] ?? current;
  const runtimes = data.agentCatalog.filter((runtime) => runtime.models.length > 0);
  const runtime =
    runtimes.find((candidate) => candidate.id === draft.runtime) ?? runtimes[0];
  if (!runtime) return state;
  const model =
    runtime.models.find((candidate) => candidate.id === draft.model) ??
    runtime.models[0]!;

  if (state.ruleField === 0) {
    const nextRuntime = cycle(runtimes, runtime);
    const nextModel = nextRuntime.models[0]!;
    return {
      ...state,
      draftRule: {
        ...draft,
        runtime: nextRuntime.id,
        model: nextModel.id,
        effort: nextModel.defaultEffort,
      },
    };
  }
  if (state.ruleField === 1) {
    const nextModel = cycle(runtime.models, model);
    return {
      ...state,
      draftRule: {
        ...draft,
        model: nextModel.id,
        effort: nextModel.defaultEffort,
      },
    };
  }
  if (state.ruleField === 2) {
    return {
      ...state,
      draftRule: {
        ...draft,
        effort: cycle(model.efforts, draft.effort),
      },
    };
  }
  return {
    ...state,
    draftRule: { ...draft, profile: cycle(PROFILES, draft.profile) },
  };
}

export function reduceCockpit(
  state: CockpitState,
  action: CockpitAction,
  data: CockpitData,
): CockpitState {
  const clean = { ...state, notice: undefined };

  if (action.type === "show-maps") return { ...clean, screen: "maps" };
  if (action.type === "show-attention") {
    return { ...clean, screen: "attention", attentionIndex: 0 };
  }
  if (action.type === "show-agents") {
    const agentsReturn =
      clean.screen === "maps" ||
      clean.screen === "map" ||
      clean.screen === "ticket" ||
      clean.screen === "map-context"
        ? clean.screen
        : clean.agentsReturn;
    return { ...clean, screen: "agents", agentIndex: 0, agentsReturn };
  }
  if (action.type === "show-context") {
    return { ...clean, screen: "map-context", scrollOffset: 0 };
  }
  if (action.type === "show-settings") {
    const settingsReturn =
      clean.screen === "maps" ||
      clean.screen === "map" ||
      clean.screen === "ticket" ||
      clean.screen === "map-context"
        ? clean.screen
        : clean.settingsReturn;
    return { ...clean, screen: "settings", settingsReturn };
  }
  if (action.type === "set-variant") {
    return moveTicket({ ...clean, variant: action.variant }, data, 0);
  }
  if (action.type === "decide-discovery") {
    const proposal = data.discoveries[clean.attentionIndex];
    if (!proposal) return clean;
    return {
      ...clean,
      discoveryDecisions: {
        ...clean.discoveryDecisions,
        [proposal.id]: action.decision,
      },
      notice: `Discovery decision: ${proposal.title} → ${action.decision}`,
    };
  }

  if (action.type === "back") {
    if (clean.screen === "maps") return clean;
    if (clean.screen === "map") return { ...clean, screen: "maps" };
    if (clean.screen === "ticket" || clean.screen === "map-context") {
      return { ...clean, screen: "map", scrollOffset: 0 };
    }
    if (clean.screen === "rule-editor" || clean.screen === "simulator") {
      return { ...clean, screen: "routing-settings", draftRule: undefined };
    }
    if (clean.screen === "agent-editor") {
      return { ...clean, screen: "agent-settings", draftRule: undefined };
    }
    if (
      clean.screen === "delivery-settings" ||
      clean.screen === "agent-settings" ||
      clean.screen === "routing-settings" ||
      clean.screen === "tracker-settings" ||
      clean.screen === "automation-settings"
    ) {
      return { ...clean, screen: "settings" };
    }
    if (clean.screen === "settings") return { ...clean, screen: clean.settingsReturn };
    if (clean.screen === "agents") return { ...clean, screen: clean.agentsReturn };
    return { ...clean, screen: "map" };
  }

  if (clean.screen === "maps") {
    if (action.type === "up" || action.type === "down") {
      const mapIndex = move(
        clean.mapIndex,
        action.type === "up" ? -1 : 1,
        data.maps.length,
      );
      const map = data.maps[mapIndex];
      const configuredDeliveryIndex = data.deliveryProfiles.findIndex(
        (profile) => profile.id === data.configuredDeliveryProfileId,
      );
      const deliveryProfileIndex = Math.max(
        0,
        configuredDeliveryIndex >= 0
          ? configuredDeliveryIndex
          : data.deliveryProfiles.findIndex(
              (profile) => profile.outcome === map?.outcome,
            ),
      );
      return {
        ...clean,
        mapIndex,
        selectedTicketId: map ? ledgerTickets(map)[0]?.id ?? "" : "",
        deliveryProfileIndex,
      };
    }
    if (action.type === "enter") return { ...clean, screen: "map" };
  }

  if (clean.screen === "map") {
    if (action.type === "up" || action.type === "down") {
      return moveTicket(clean, data, action.type === "up" ? -1 : 1);
    }
    if (action.type === "enter") {
      return { ...clean, screen: "ticket", scrollOffset: 0 };
    }
  }

  if (clean.screen === "ticket" || clean.screen === "map-context") {
    if (action.type === "up" || action.type === "down") {
      return {
        ...clean,
        scrollOffset: Math.max(0, clean.scrollOffset + (action.type === "up" ? -1 : 1)),
      };
    }
    if (action.type === "page-up" || action.type === "page-down") {
      return {
        ...clean,
        scrollOffset: Math.max(
          0,
          clean.scrollOffset + (action.type === "page-up" ? -8 : 8),
        ),
      };
    }
  }

  if (clean.screen === "agents") {
    if (action.type === "up" || action.type === "down") {
      return {
        ...clean,
        agentIndex: move(
          clean.agentIndex,
          action.type === "up" ? -1 : 1,
          buildActivityItems(data).length,
        ),
      };
    }
  }

  if (clean.screen === "attention") {
    if (action.type === "up" || action.type === "down") {
      return {
        ...clean,
        attentionIndex: move(
          clean.attentionIndex,
          action.type === "up" ? -1 : 1,
          data.discoveries.length,
        ),
      };
    }
  }

  if (clean.screen === "settings") {
    if (action.type === "up" || action.type === "down") {
      return {
        ...clean,
        settingsIndex: move(clean.settingsIndex, action.type === "up" ? -1 : 1, 5),
      };
    }
    if (action.type === "enter") {
      const screens: Screen[] = [
        "delivery-settings",
        "agent-settings",
        "routing-settings",
        "tracker-settings",
        "automation-settings",
      ];
      const screen = screens[clean.settingsIndex] ?? "settings";
      return {
        ...clean,
        screen,
        deliveryCursor:
          screen === "delivery-settings"
            ? clean.deliveryProfileIndex
            : clean.deliveryCursor,
      };
    }
  }

  if (clean.screen === "delivery-settings") {
    if (action.type === "up" || action.type === "down") {
      return {
        ...clean,
        deliveryCursor: move(
          clean.deliveryCursor,
          action.type === "up" ? -1 : 1,
          data.deliveryProfiles.length,
        ),
      };
    }
    if (action.type === "enter") {
      return {
        ...clean,
        deliveryProfileIndex: clean.deliveryCursor,
        notice: `${data.deliveryProfiles[clean.deliveryCursor]?.label ?? "Delivery workflow"} selected`,
      };
    }
  }

  if (clean.screen === "agent-settings") {
    if (action.type === "up" || action.type === "down") {
      return {
        ...clean,
        agentDefaultIndex: move(
          clean.agentDefaultIndex,
          action.type === "up" ? -1 : 1,
          2,
        ),
      };
    }
    if (action.type === "enter") {
      const hitl = clean.agentDefaultIndex === 0;
      const configured = data.agentDefaults?.[hitl ? "HITL" : "AFK"];
      const target = normalizeRuleTarget(
        {
          id: hitl ? "hitl-default" : "afk-default",
          name: hitl ? "HITL default" : "AFK default",
          when: hitl ? "mode:HITL" : "mode:AFK",
          runtime: configured?.runtime ?? "Pi",
          model: configured?.model ?? "inherit",
          effort: configured?.effort ?? (hitl ? "high" : "medium"),
          profile: configured?.profile ?? (hitl ? "worker" : "researcher"),
          enabled: true,
        },
        data,
      );
      return {
        ...clean,
        screen: "agent-editor",
        draftRule: target,
        ruleField: 0,
      };
    }
  }

  if (clean.screen === "routing-settings") {
    if (action.type === "up" || action.type === "down") {
      return {
        ...clean,
        ruleIndex: move(
          clean.ruleIndex,
          action.type === "up" ? -1 : 1,
          data.routes.length + 1,
        ),
      };
    }
    if (action.type === "enter") {
      if (clean.ruleIndex === data.routes.length) {
        return { ...clean, screen: "simulator" };
      }
      const rule = data.routes[clean.ruleIndex];
      return rule
        ? {
            ...clean,
            screen: "rule-editor",
            draftRule: normalizeRuleTarget({ ...rule }, data),
            ruleField: 0,
          }
        : clean;
    }
  }

  if (clean.screen === "tracker-settings") {
    if (action.type === "up" || action.type === "down") {
      return {
        ...clean,
        trackerIndex: move(
          clean.trackerIndex,
          action.type === "up" ? -1 : 1,
          data.trackers.length,
        ),
      };
    }
    if (
      (action.type === "left" || action.type === "right") &&
      data.trackers[clean.trackerIndex]?.id === "jira"
    ) {
      return {
        ...clean,
        jiraBoardIndex: move(
          clean.jiraBoardIndex,
          action.type === "left" ? -1 : 1,
          data.jiraBoards?.length ?? 0,
        ),
      };
    }
    if (action.type === "enter") {
      const tracker = data.trackers[clean.trackerIndex];
      const board = tracker?.id === "jira"
        ? data.jiraBoards?.[clean.jiraBoardIndex]
        : undefined;
      return {
        ...clean,
        notice: `${tracker?.label ?? "Tracker"}${board ? ` · ${board.name}` : ""} selected`,
      };
    }
  }

  if (clean.screen === "automation-settings") {
    if (action.type === "up" || action.type === "down") {
      return {
        ...clean,
        automationIndex: move(
          clean.automationIndex,
          action.type === "up" ? -1 : 1,
          6,
        ),
      };
    }
    if (action.type === "enter") {
      return {
        ...clean,
        notice: "Automation values are displayed from the persisted workspace policy",
      };
    }
  }

  if (clean.screen === "rule-editor" || clean.screen === "agent-editor") {
    if (action.type === "up" || action.type === "down") {
      return {
        ...clean,
        ruleField: move(clean.ruleField, action.type === "up" ? -1 : 1, 4),
      };
    }
    if (action.type === "left" || action.type === "right") {
      return cycleDraftRule(clean, data, action.type === "left" ? -1 : 1);
    }
    if (action.type === "enter") {
      return {
        ...clean,
        screen:
          clean.screen === "agent-editor"
            ? "agent-settings"
            : "routing-settings",
        draftRule: undefined,
        notice: "Target accepted",
      };
    }
  }

  if (clean.screen === "simulator" && (action.type === "up" || action.type === "down")) {
    return {
      ...clean,
      simulatorIndex: move(clean.simulatorIndex, action.type === "up" ? -1 : 1, 3),
    };
  }

  return clean;
}
