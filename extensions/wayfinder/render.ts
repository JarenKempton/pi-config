import type { Theme } from "@earendil-works/pi-coding-agent";
import { buildActivityItems, type ActivityCategory } from "./activity.ts";
import {
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  dependencyTickets,
  ledgerTickets,
  presentationState,
  selectedMap,
  selectedTicket,
  type CockpitState,
} from "./state.ts";
import type {
  DeliveryProfile,
  DiscoveryProposal,
  CockpitData,
  Ticket,
  WayfinderMap,
  WayfinderRun,
} from "./types.ts";

const MAX_BODY_LINES = 25;

function fit(value: string, width: number) {
  return truncateToWidth(value, Math.max(0, width), "…");
}

function pad(value: string, width: number) {
  const clipped = fit(value, width);
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function wrap(value: string, width: number) {
  const words = value.trim().split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
    } else if (visibleWidth(`${current} ${word}`) <= width) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function columns(
  left: string[],
  right: string[],
  width: number,
  leftWidth: number,
  theme: Theme,
) {
  const divider = theme.fg("borderMuted", "│");
  const rightWidth = Math.max(1, width - leftWidth - 3);
  const count = Math.max(left.length, right.length);
  return Array.from({ length: count }, (_, index) => {
    const leftLine = left[index] ?? "";
    const rightLine = right[index] ?? "";
    return `${pad(leftLine, leftWidth)} ${divider} ${fit(rightLine, rightWidth)}`;
  });
}

function section(theme: Theme, label: string, count?: number) {
  const suffix = count === undefined ? "" : `  ${count}`;
  return theme.fg("dim", `${label}${suffix}`);
}

function stateLabel(
  ticket: Ticket,
  delivery: DeliveryProfile,
  theme: Theme,
) {
  if (ticket.trackerState === "migrated") return theme.fg("warning", "MOVED");
  const state = presentationState(ticket);
  if (state === "frontier") return theme.fg("success", "READY");
  if (state === "in-flight") return theme.fg("accent", "ACTIVE");
  if (state === "attention") return theme.fg("warning", "ATTENTION");
  if (state === "waiting") return theme.fg("warning", delivery.waitingLabel);
  if (state === "blocked") return theme.fg("error", "BLOCKED");
  return theme.fg("dim", "RESOLVED");
}

function ticketMeta(ticket: Ticket, theme: Theme) {
  const pieces: string[] = [ticket.type, ticket.mode];
  if (ticket.agent) pieces.push(`${ticket.agent.runtime} ${ticket.agent.state}`);
  if (ticket.workspace) pieces.push("worktree");
  if (ticket.review) pieces.push(`PR #${ticket.review.number}`);
  return theme.fg("muted", pieces.join(" · "));
}

function ticketLine(
  ticket: Ticket,
  selected: boolean,
  delivery: DeliveryProfile,
  theme: Theme,
  prefix = "",
) {
  const marker = selected ? theme.fg("accent", "›") : " ";
  const title = selected ? theme.bold(ticket.title) : theme.fg("text", ticket.title);
  return `${marker} ${prefix}${stateLabel(ticket, delivery, theme)}  ${theme.fg("muted", ticket.id)}  ${title}`;
}

function mapCounts(map: WayfinderMap) {
  const counts = {
    frontier: 0,
    active: 0,
    attention: 0,
    waiting: 0,
    blocked: 0,
    resolved: 0,
  };
  for (const ticket of map.tickets) {
    const state = presentationState(ticket);
    if (state === "frontier") counts.frontier++;
    else if (state === "in-flight") counts.active++;
    else counts[state]++;
  }
  return counts;
}

function migratedMap(map: WayfinderMap) {
  return map.source?.canonical === true && map.source.provider !== "github" && Boolean(map.mirror);
}

function mapSectionSummary(map: WayfinderMap) {
  const known = [
    `NOTES ${map.notes.length}`,
    `DECISIONS ${map.decisions?.length ?? 0}`,
    `FOG ${map.fog.length}`,
    `OUT OF SCOPE ${map.outOfScope?.length ?? 0}`,
  ];
  const custom = (map.sections ?? [])
    .filter(
      (item) =>
        !["destination", "notes", "decisions so far", "not yet specified", "out of scope"].includes(
          item.heading.toLowerCase(),
        ),
    )
    .map((item) => item.heading.toUpperCase());
  return [...known, ...custom].join(" · ");
}

function mapPicker(
  state: CockpitState,
  data: CockpitData,
  theme: Theme,
  width: number,
) {
  const selected = selectedMap(state, data);
  const refresh = data.trackerRefresh;
  const refreshLabel = refresh?.state === "refreshing"
    ? " · refreshing"
    : refresh?.state === "error"
      ? " · refresh failed"
      : "";
  const list: string[] = [section(theme, `MAPS  ${data.maps.length}${refreshLabel}`), ""];
  data.maps.forEach((map, index) => {
    const marker = index === state.mapIndex ? theme.fg("accent", "›") : " ";
    const title = index === state.mapIndex ? theme.bold(map.title) : theme.fg("text", map.title);
    const mapState = migratedMap(map)
      ? theme.fg("warning", "MOVED")
      : map.state === "closed"
        ? theme.fg("dim", "CLOSED")
        : theme.fg("success", "OPEN");
    const kind = map.kind === "epic" ? theme.fg("accent", "EPIC") : theme.fg("muted", "MAP");
    list.push(`${marker} ${mapState}  ${kind}  ${title}`);
  });

  const counts = mapCounts(selected);
  const detail = [
    section(theme, "DESTINATION"),
    ...wrap(selected.destination, Math.max(24, width > 86 ? Math.floor(width * 0.46) : width)).map((line) =>
      theme.fg("text", line),
    ),
    "",
    section(theme, "MAP STATE"),
    `${theme.fg("success", `${counts.frontier} frontier`)}  ${theme.fg("accent", `${counts.active} in flight`)}  ${theme.fg("warning", `${counts.attention} attention`)}`,
    `${theme.fg("error", `${counts.blocked} blocked`)}  ${theme.fg("muted", `${counts.waiting} waiting`)}  ${theme.fg("dim", `${counts.resolved} resolved`)}`,
    "",
    section(theme, "EXECUTION"),
    `${selected.autoRun ? theme.fg("success", "● AFK auto-run") : theme.fg("dim", "○ AFK manual")}  ${theme.fg("muted", `${selected.state} · updated ${selected.updated}`)}`,
    theme.fg("dim", `Map ref ${selected.id}`),
    ...(migratedMap(selected)
      ? [
          theme.fg("warning", "Canonical source: Linear · GitHub is a stale migration mirror"),
          theme.fg("dim", selected.source?.url ?? ""),
        ]
      : []),
  ];

  if (width >= 86) {
    const leftWidth = Math.max(34, Math.floor(width * 0.48));
    return columns(list, detail, width, leftWidth, theme);
  }
  return [...list, "", ...detail.slice(0, 8)];
}

function compactTicketDetail(
  ticket: Ticket,
  delivery: DeliveryProfile,
  theme: Theme,
  width: number,
  run?: WayfinderRun,
) {
  const lines = [
    section(theme, "SELECTED TICKET"),
    `${theme.bold(`${ticket.id} ${ticket.title}`)}`,
    `${stateLabel(ticket, delivery, theme)}  ${ticketMeta(ticket, theme)}`,
    "",
    ...wrap(ticket.question, Math.max(20, width)).map((line) => theme.fg("text", line)),
    "",
    section(theme, "RUNTIME STATE"),
  ];
  if (ticket.blockedBy.length) {
    lines.push(`${theme.fg("error", "Blocked by")} ${ticket.blockedBy.join(", ")}`);
  } else {
    lines.push(theme.fg("success", "No open blockers"));
  }
  if (run) {
    lines.push(
      `${run.backend} · ${run.model ?? "default"} · ${run.status} · ${run.id}`,
    );
  } else if (ticket.agent) {
    lines.push(
      `${ticket.agent.runtime} · ${ticket.agent.model} · ${ticket.agent.effort} · ${ticket.agent.state}`,
    );
  } else {
    lines.push(theme.fg("dim", "No agent run"));
  }
  if (ticket.workspace) {
    const worktreeState = ticket.workspace.dirty === true
      ? theme.fg("warning", "● dirty")
      : ticket.workspace.dirty === false
        ? theme.fg("success", "● clean")
        : theme.fg("accent", "● linked");
    lines.push(`${worktreeState} ${ticket.workspace.branch}`);
  } else {
    lines.push(theme.fg("dim", "No linked worktree"));
  }
  if (ticket.review) {
    lines.push(
      `PR #${ticket.review.number} · ${ticket.review.state} · checks ${ticket.review.checks}`,
    );
  }
  return lines;
}

function ledgerVariant(
  map: WayfinderMap,
  state: CockpitState,
  delivery: DeliveryProfile,
  theme: Theme,
) {
  const lines: string[] = [];
  const groups = [
    ["frontier", "FRONTIER"],
    ["in-flight", "IN FLIGHT"],
    ["attention", "ATTENTION"],
    ["waiting", delivery.waitingLabel],
    ["blocked", "BLOCKED"],
    ["resolved", "RESOLVED"],
  ] as const;
  const ordered = ledgerTickets(map);
  for (const [key, label] of groups) {
    const tickets = ordered.filter((ticket) => presentationState(ticket) === key);
    if (!tickets.length) continue;
    if (lines.length) lines.push("");
    lines.push(section(theme, label, tickets.length));
    for (const ticket of tickets) {
      lines.push(ticketLine(ticket, ticket.id === state.selectedTicketId, delivery, theme));
    }
  }
  return lines;
}

function dependencyVariant(
  map: WayfinderMap,
  state: CockpitState,
  delivery: DeliveryProfile,
  theme: Theme,
) {
  const lines = [section(theme, "DECISION / DELIVERY OUTLINE"), ""];
  for (const { ticket, depth } of dependencyTickets(map)) {
    const branch = depth === 0 ? "" : `${"  ".repeat(depth - 1)}└─ `;
    lines.push(
      ticketLine(ticket, ticket.id === state.selectedTicketId, delivery, theme, branch),
    );
    if (depth === 0 && ticket.blockedBy.length === 0) {
      const children = map.tickets.filter((item) => item.blockedBy.includes(ticket.id));
      if (children.length) {
        lines.push(
          theme.fg("dim", `    unlocks ${children.map((child) => child.id).join(", ")}`),
        );
      }
    }
  }
  lines.push("", theme.fg("dim", "Indentation shows blocker relationships, not ownership."));
  return lines;
}

function focusVariant(
  map: WayfinderMap,
  ticket: Ticket,
  delivery: DeliveryProfile,
  theme: Theme,
  width: number,
) {
  const counts = mapCounts(map);
  const sectionLines = (map.sections ?? [])
    .filter((item) => item.heading.toLowerCase() !== "destination")
    .flatMap((item) => {
      const preview = inlineMarkdown(item.body)
        .replace(/<!--[^]*?-->/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return [
        section(theme, item.heading.toUpperCase(), item.items.length || undefined),
        ...wrap(preview || "No content recorded.", Math.max(24, width)).slice(0, 1),
      ];
    });
  return [
    section(theme, "MAP BRIEF"),
    ...wrap(map.destination, Math.max(24, width)).slice(0, 3),
    "",
    ...sectionLines,
    section(theme, "QUEUE"),
    `  ${theme.fg("success", `${counts.frontier} ready`)}  ${theme.fg("accent", `${counts.active} active`)}  ${theme.fg("warning", `${counts.attention} moved/attention`)}  ${theme.fg("error", `${counts.blocked} blocked`)}`,
    "",
    section(theme, "SELECTED TICKET"),
    `${theme.fg("accent", "◆")} ${theme.bold(`${ticket.id} ${ticket.title}`)}  ${stateLabel(ticket, delivery, theme)}`,
  ];
}

function mapBoard(
  state: CockpitState,
  data: CockpitData,
  theme: Theme,
  width: number,
) {
  const map = selectedMap(state, data);
  const ticket = selectedTicket(state, data);
  const delivery = data.deliveryProfiles[state.deliveryProfileIndex]!;
  const run = data.runs?.find(
    (candidate) => candidate.mapId === map.id && candidate.ticketId === ticket.id,
  );
  const tabs = [1, 2, 3]
    .map((variant) => {
      const labels = ["Ledger", "Outline", "Brief"];
      const text = ` ${variant} ${labels[variant - 1]} `;
      return variant === state.variant
        ? theme.bg("selectedBg", theme.fg("accent", text))
        : theme.fg("dim", text);
    })
    .join(" ");
  const intro = [
    `${theme.fg("accent", map.kind === "epic" ? "EPIC" : "MAP")}  ${theme.bold(map.title)}  ${theme.fg("dim", map.repository)}`,
    ...(migratedMap(map)
      ? [theme.fg("warning", `MOVED · canonical ${map.source?.provider ?? "external"} map is not loaded · ${map.source?.id ?? ""}`)]
      : []),
    `${theme.fg("muted", `Outcome: ${delivery.outcome}`)}  ${theme.fg("muted", `Policy: ${delivery.label}`)}  ${map.autoRun ? theme.fg("success", "AFK AUTO") : theme.fg("dim", "AFK MANUAL")}`,
    theme.fg("dim", mapSectionSummary(map)),
    tabs,
    "",
  ];
  let body: string[];
  if (state.variant === 1) body = ledgerVariant(map, state, delivery, theme);
  else if (state.variant === 2) body = dependencyVariant(map, state, delivery, theme);
  else body = focusVariant(map, ticket, delivery, theme, Math.floor(width * 0.58));

  if (width >= 94 && state.variant !== 3) {
    return [
      ...intro,
      ...columns(
        body,
        compactTicketDetail(ticket, delivery, theme, Math.floor(width * 0.38), run),
        width,
        Math.max(48, Math.floor(width * 0.58)),
        theme,
      ),
    ];
  }
  return [...intro, ...body, "", ...compactTicketDetail(ticket, delivery, theme, width, run).slice(0, 5)];
}

function inlineMarkdown(value: string) {
  return value
    .replace(/\[([^\]]+)]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\*\*/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/__([^_]+)__/g, "$1");
}

function markdownLines(value: string, width: number, theme: Theme) {
  const lines: string[] = [];
  for (const sourceLine of value.split("\n")) {
    const heading = sourceLine.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      lines.push("", theme.bold(inlineMarkdown(heading[2] ?? "")));
      continue;
    }
    const bullet = sourceLine.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      const wrapped = wrap(inlineMarkdown(bullet[1] ?? ""), Math.max(12, width - 3));
      lines.push(...wrapped.map((line, index) => `${index === 0 ? " • " : "   "}${line}`));
      continue;
    }
    if (!sourceLine.trim()) {
      if (lines.at(-1) !== "") lines.push("");
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(sourceLine)) {
      lines.push(fit(inlineMarkdown(sourceLine.trim()), width));
      continue;
    }
    lines.push(...wrap(inlineMarkdown(sourceLine.trim()), width));
  }
  return lines;
}

function commentsLines(
  comments: Ticket["comments"] | WayfinderMap["comments"],
  width: number,
  theme: Theme,
) {
  if (!comments?.length) return [];
  const lines = ["", section(theme, `COMMENTS / RESOLUTIONS  ${comments.length}`)];
  comments.forEach((comment) => {
    const date = comment.createdAt ? new Date(comment.createdAt).toLocaleString() : "unknown time";
    lines.push("", theme.bold(`@${comment.author}`) + theme.fg("dim", ` · ${date}`));
    lines.push(...markdownLines(comment.body, width, theme));
  });
  return lines;
}

function scrollWindow(lines: string[], offset: number, height: number) {
  const bounded = Math.min(Math.max(0, offset), Math.max(0, lines.length - height));
  return {
    lines: lines.slice(bounded, bounded + height),
    position: `${lines.length ? bounded + 1 : 0}–${Math.min(lines.length, bounded + height)} of ${lines.length}`,
  };
}

function ticketScreen(
  state: CockpitState,
  data: CockpitData,
  theme: Theme,
  width: number,
) {
  const ticket = selectedTicket(state, data);
  const map = selectedMap(state, data);
  const delivery = data.deliveryProfiles[state.deliveryProfileIndex]!;
  const dependencies = ticket.dependencies ?? [];
  const run = data.runs?.find(
    (candidate) => candidate.mapId === map.id && candidate.ticketId === ticket.id,
  );
  const documentWidth = Math.max(20, width - 2);
  const document = [
    ...markdownLines(ticket.body || ticket.question, documentWidth, theme),
    ...(dependencies.length
      ? [
          "",
          section(theme, `ALL DEPENDENCIES  ${dependencies.length}`),
          ...dependencies.map((dependency) =>
            ` ${dependency.state === "open" ? theme.fg("error", "● OPEN") : theme.fg("success", "✓ CLOSED")}  ${dependency.id} ${dependency.title}`,
          ),
        ]
      : []),
    ...commentsLines(ticket.comments, documentWidth, theme),
    ...(ticket.hydrating
      ? ["", theme.fg("accent", "Loading comments and dependency edges…")]
      : !ticket.hydrated
        ? ["", theme.fg("dim", "Detailed comments and dependency edges are not loaded. Press r to retry.")]
        : []),
  ];
  const visible = scrollWindow(document, state.scrollOffset, 15);
  const metadata = [
    `${theme.bold(map.title)} ${theme.fg("dim", "/")} ${theme.bold(`${ticket.id} ${ticket.title}`)}`,
    `${stateLabel(ticket, delivery, theme)}  ${ticketMeta(ticket, theme)}  ${theme.fg("dim", ticket.url ?? "")}`,
    ...(ticket.trackerState === "migrated"
      ? [theme.fg("warning", `Canonical Linear ticket ${ticket.source?.id ?? ""} is not loaded · ${ticket.source?.url ?? ""}`)]
      : []),
    `Labels: ${ticket.labels?.join(", ") || "none"}  ·  Assignees: ${ticket.assignees?.map((name) => `@${name}`).join(", ") || "none"}`,
    `Open blockers: ${ticket.blockedBy.join(", ") || "none"}  ·  Dependencies recorded: ${dependencies.length}  ·  Comments: ${ticket.commentCount ?? ticket.comments?.length ?? 0}`,
  ];
  if (run) {
    metadata.push(
      `Agent: ${run.id} · ${run.backend}/${run.profile} · ${run.model ?? "default"} · ${run.status}`,
    );
  }
  if (ticket.workspace) {
    metadata.push(`Worktree: ${ticket.workspace.branch} · ${ticket.workspace.path}`);
  }
  if (ticket.review) {
    metadata.push(
      `PR #${ticket.review.number} ${ticket.review.title ?? ""} · ${ticket.review.state} · checks ${ticket.review.checks}`,
    );
  }
  return [
    ...metadata,
    theme.fg("borderMuted", "─".repeat(documentWidth)),
    ...visible.lines,
    "",
    theme.fg("dim", `Document ${visible.position} · full issue body, dependencies, and comments`),
  ];
}

function mapContextScreen(
  state: CockpitState,
  data: CockpitData,
  theme: Theme,
  width: number,
) {
  const map = selectedMap(state, data);
  const documentWidth = Math.max(20, width - 2);
  const document = [
    ...markdownLines(map.body || map.destination, documentWidth, theme),
    ...commentsLines(map.comments, documentWidth, theme),
  ];
  const visible = scrollWindow(document, state.scrollOffset, 18);
  return [
    theme.bold(map.title),
    `${migratedMap(map) ? "MOVED" : map.state.toUpperCase()} · ${map.repository} · ${theme.fg("dim", map.url ?? map.id)}`,
    ...(migratedMap(map)
      ? [theme.fg("warning", `Canonical Linear map not loaded · ${map.source?.url ?? ""}`)]
      : []),
    `Labels: ${map.labels?.join(", ") || "none"} · ${map.tickets.length} child tickets · updated ${map.updated}`,
    theme.fg("borderMuted", "─".repeat(documentWidth)),
    ...visible.lines,
    "",
    theme.fg("dim", `Map document ${visible.position} · full body and comments`),
  ];
}

function proposalStatus(
  proposal: DiscoveryProposal,
  state: CockpitState,
  theme: Theme,
) {
  const decision = state.discoveryDecisions[proposal.id];
  if (decision === "accepted") return theme.fg("success", "ACCEPTED");
  if (decision === "fog") return theme.fg("muted", "FOG");
  if (decision === "dismissed") return theme.fg("dim", "DISMISSED");
  return theme.fg("warning", "PROPOSED");
}

function attentionScreen(
  state: CockpitState,
  data: CockpitData,
  theme: Theme,
  width: number,
) {
  const proposal = data.discoveries[state.attentionIndex];
  if (!proposal) {
    return [
      section(theme, "DISCOVERY INBOX"),
      "",
      theme.fg("success", "No discovery proposals need attention."),
      theme.fg("dim", "Live tracker data does not currently contain pending agent discoveries."),
    ];
  }
  const list = [section(theme, `DISCOVERY INBOX  ${data.discoveries.length}`), ""];
  data.discoveries.forEach((item, index) => {
    const marker = index === state.attentionIndex ? theme.fg("accent", "›") : " ";
    list.push(`${marker} ${theme.fg("muted", item.sourceTicketId)}  ${item.title}`);
    list.push(`  ${proposalStatus(item, state, theme)} · ${theme.fg("dim", item.kind)}`);
  });
  const route = proposal.suggestedDomains.includes("UI")
    ? data.routes[0]
    : proposal.suggestedCapabilities.includes("web")
      ? data.routes[1]
      : data.routes[2];
  const detail = [
    section(theme, "PROPOSED MAP MUTATION"),
    theme.bold(proposal.title),
    `${theme.fg("warning", proposal.kind.toUpperCase())} from ${proposal.sourceTicketId}`,
    "",
    ...wrap(proposal.rationale, Math.max(25, Math.floor(width * 0.49))).map((line) =>
      theme.fg("text", line),
    ),
    "",
    section(theme, "SUGGESTED TICKET"),
    `${proposal.suggestedType} · ${proposal.suggestedMode}`,
    `Domains       ${proposal.suggestedDomains.join(", ")}`,
    `Capabilities  ${proposal.suggestedCapabilities.join(", ")}`,
    "",
    section(theme, "ROUTING PREVIEW"),
    route
      ? `${route.name} → ${route.runtime} / ${route.model} / ${route.effort}`
      : theme.fg("warning", "No matching rule"),
    "",
    theme.fg("dim", "a accept · f move to Fog · d dismiss"),
  ];
  if (width >= 86) return columns(list, detail, width, Math.floor(width * 0.42), theme);
  return [...list, "", ...detail];
}

function agentsScreen(
  state: CockpitState,
  data: CockpitData,
  theme: Theme,
  width: number,
) {
  const items = buildActivityItems(data);
  if (!items.length) {
    return [
      section(theme, "ACTIVITY"),
      "",
      theme.fg("muted", "No tracker frontiers or agent sessions are available."),
    ];
  }

  const categoryLabel = (category: ActivityCategory) => {
    if (category === "moving") return theme.fg("accent", "● MOVING");
    if (category === "needs-input") return theme.fg("warning", "◆ INPUT");
    if (category === "result-ready") return theme.fg("success", "◆ RESULT READY");
    if (category === "failed") return theme.fg("error", "● FAILED");
    if (category === "ready") return theme.fg("success", "○ READY");
    if (category === "waiting") return theme.fg("warning", "○ WAITING");
    if (category === "resolved") return theme.fg("dim", "✓ RESOLVED");
    return theme.fg("dim", "○ ARCHIVED");
  };
  const counts = new Map<ActivityCategory, number>();
  for (const item of items) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  const selectedIndex = Math.min(state.agentIndex, items.length - 1);
  const selected = items[selectedIndex]!;
  const windowSize = 16;
  const start = Math.min(
    Math.max(0, selectedIndex - Math.floor(windowSize / 2)),
    Math.max(0, items.length - windowSize),
  );
  const visible = items.slice(start, start + windowSize);
  const summary = [
    `${counts.get("moving") ?? 0} moving`,
    `${counts.get("needs-input") ?? 0} input`,
    `${counts.get("result-ready") ?? 0} results`,
    `${counts.get("ready") ?? 0} ready`,
    `${counts.get("waiting") ?? 0} waiting`,
  ].join(" · ");
  const list = [section(theme, `ACTIVITY  ${items.length}`), theme.fg("dim", summary), ""];
  visible.forEach((item, offset) => {
    const index = start + offset;
    const marker = index === selectedIndex ? theme.fg("accent", "›") : " ";
    const ticketId = item.ticket?.id ?? item.run?.ticketId ?? "";
    list.push(`${marker} ${categoryLabel(item.category)}  ${ticketId} ${item.title}`);
  });
  if (start > 0) list[2] = theme.fg("dim", `↑ ${start} earlier rows`);
  if (start + visible.length < items.length) {
    list.push(theme.fg("dim", `  ↓ ${items.length - start - visible.length} more rows`));
  }

  const ticket = selected.ticket;
  const run = selected.run;
  const detail = [
    section(theme, run ? "AGENT SESSION" : "TRACKER FRONTIER"),
    theme.bold(selected.title),
    `${selected.map?.title ?? selected.run?.mapId ?? "Unlinked session"}${ticket ? ` / ${ticket.id}` : ""}`,
    "",
    `State        ${selected.category}`,
    ...(ticket
      ? [
          `Tracker      ${ticket.trackerState}`,
          `Mode         ${ticket.mode}`,
          `Blockers     ${ticket.blockedBy.join(", ") || "none"}`,
        ]
      : []),
    ...(run
      ? [
          `Agent ID     ${run.id}`,
          `Runtime      ${run.backend}`,
          `Model        ${run.model ?? "default"}`,
          `Effort       ${run.effort ?? "runtime default"}`,
          `Profile      ${run.profile}`,
          `Session      ${run.sessionFilePath ?? run.nativeSessionId ?? "active host only"}`,
          "",
          section(theme, "LATEST RESULT"),
          ...wrap(run.finalText || "Agent is still working.", Math.max(24, Math.floor(width * 0.44)))
            .slice(0, 5)
            .map((line) => theme.fg("muted", line)),
        ]
      : ["", theme.fg("dim", "Enter opens this ticket · n starts it from the ticket view")]),
  ];
  if (width >= 86) return columns(list, detail, width, Math.floor(width * 0.54), theme);
  return [...list, "", ...detail];
}

function settingsMenu(
  state: CockpitState,
  data: CockpitData,
  theme: Theme,
  width: number,
) {
  const delivery = data.deliveryProfiles[state.deliveryProfileIndex]!;
  const tracker = data.trackers[state.trackerIndex]!;
  const jiraBoard = data.jiraBoards?.find(
    (board) => board.id === data.configuredJiraBoardId,
  );
  const items = [
    ["Delivery workflow", delivery.label],
    ["Agent defaults", "Pi · inherited model"],
    ["Model routing", `${data.routes.length} ordered rules`],
    [
      "Issue tracker",
      `${tracker.label}${tracker.id === "jira" && jiraBoard ? ` · ${jiraBoard.name}` : ""}`,
    ],
    ["Automation & safety", "Ask before map mutations"],
  ];
  const descriptions = [
    "Choose whether this map ends at a specification, implemented change, or deployed feature—and which approval and quality gates apply.",
    "Set the default runtime, model, effort, and permission profile for HITL and AFK work.",
    "Route ticket traits such as UI research or long web collection to an explicit agent target.",
    "Connect Wayfinder's tracker instructions to a capability-based cockpit adapter.",
    "Control AFK dispatch, discovered tickets, concurrency, and runaway limits.",
  ];
  const list = [
    theme.bold("Settings"),
    theme.fg("dim", `Repository · ${data.maps[0]?.repository ?? "current workspace"}`),
    theme.fg(
      "dim",
      `${data.settingsPersisted ? "● persisted" : "○ defaults until first save"} · ${data.settingsPath ?? "local settings file"}`,
    ),
    "",
    ...items.flatMap(([label, value], index) => [
      `${index === state.settingsIndex ? theme.fg("accent", "›") : " "} ${index === state.settingsIndex ? theme.bold(label) : label}`,
      `    ${theme.fg("dim", value)}`,
    ]),
  ];
  const detail = [
    section(theme, "SELECTED SECTION"),
    theme.bold(items[state.settingsIndex]?.[0] ?? "Settings"),
    "",
    ...wrap(descriptions[state.settingsIndex] ?? "", Math.max(24, Math.floor(width * 0.44))).map(
      (line) => theme.fg("text", line),
    ),
    "",
    theme.fg("dim", "Press Enter to configure this section."),
  ];
  if (width >= 82) return columns(list, detail, width, Math.floor(width * 0.48), theme);
  return [...list, "", ...detail];
}

function deliverySettings(
  state: CockpitState,
  data: CockpitData,
  theme: Theme,
  width: number,
) {
  const delivery = data.deliveryProfiles[state.deliveryCursor]!;
  const list = [section(theme, "DELIVERY WORKFLOW"), ""];
  data.deliveryProfiles.forEach((profile, index) => {
    const selected = index === state.deliveryCursor;
    const applied = index === state.deliveryProfileIndex ? theme.fg("success", "✓") : " ";
    list.push(`${selected ? theme.fg("accent", "›") : " "} ${applied} ${selected ? theme.bold(profile.label) : profile.label}`);
    list.push(`      ${theme.fg("dim", `${profile.outcome} · ${profile.integration}`)}`);
  });
  const detail = [
    section(theme, state.deliveryCursor === state.deliveryProfileIndex ? "EFFECTIVE POLICY" : "POLICY PREVIEW"),
    theme.bold(delivery.label),
    "",
    `Outcome       ${delivery.outcome}`,
    `Approval      ${delivery.approval}`,
    `Integration   ${delivery.integration}`,
    `Release       ${delivery.release}`,
    "",
    section(theme, "REQUIRED EVIDENCE"),
    ...delivery.quality.map((item) => `  ○ ${item}`),
    "",
    theme.fg("dim", "Press Enter to persist this workspace policy."),
  ];
  if (width >= 82) return columns(list, detail, width, Math.floor(width * 0.45), theme);
  return [...list, "", ...detail];
}

function agentSettings(
  state: CockpitState,
  data: CockpitData,
  theme: Theme,
  width: number,
) {
  const hitl = data.agentDefaults?.HITL ?? {
    runtime: "Pi",
    model: "inherit",
    effort: "high",
    profile: "worker",
  };
  const afk = data.agentDefaults?.AFK ?? {
    runtime: "Pi",
    model: "inherit",
    effort: "medium",
    profile: "researcher",
  };
  const defaults = [
    ["Human-in-the-loop", `${hitl.runtime} · ${hitl.model} · ${hitl.effort} · ${hitl.profile}`],
    ["AFK", `${afk.runtime} · ${afk.model} · ${afk.effort} · ${afk.profile}`],
  ];
  const list = [section(theme, "AGENT DEFAULTS"), ""];
  defaults.forEach(([label, value], index) => {
    const selected = index === state.agentDefaultIndex;
    list.push(`${selected ? theme.fg("accent", "›") : " "} ${selected ? theme.bold(label) : label}`);
    list.push(`    ${theme.fg("dim", value)}`);
  });
  list.push("", theme.fg("dim", "Press Enter to edit the selected target."));
  const detail = [
    section(theme, "AVAILABLE RUNTIMES"),
    "",
    ...data.agentCatalog.flatMap((runtime) => [
      `${runtime.models.length ? theme.fg("success", "●") : theme.fg("error", "○")} ${theme.bold(runtime.id)}  ${runtime.models.length} model${runtime.models.length === 1 ? "" : "s"}`,
      `  ${theme.fg("dim", runtime.source)}`,
    ]),
    "",
    section(theme, "RESOLUTION ORDER"),
    "Runtime → available models → supported effort levels",
    theme.fg("dim", "Routing rules may override these defaults."),
  ];
  if (width >= 82) return columns(list, detail, width, Math.floor(width * 0.43), theme);
  return [...list, "", ...detail];
}

function automationSettings(state: CockpitState, theme: Theme) {
  const values = [
    ["AFK dispatch", "Enabled for research"],
    ["Task dispatch", "Explicit AFK trait required"],
    ["Discovery handling", "Ask first"],
    ["Auto-create", "In-territory research only"],
    ["Auto-resolve", "Off"],
    ["Runaway limits", "depth 2 · 3 tickets · 2 concurrent"],
  ];
  return [
    section(theme, "AUTOMATION & SAFETY"),
    "",
    ...values.flatMap(([label, value], index) => {
      const selected = index === state.automationIndex;
      return [
        `${selected ? theme.fg("accent", "›") : " "} ${selected ? theme.bold(label) : label}`,
        `    ${theme.fg("dim", value)}`,
      ];
    }),
    "",
    section(theme, "GUARDRAIL"),
    "Unrestricted profiles are never selected automatically.",
    "A limit pauses the run and creates an Attention item.",
    "",
    theme.fg("dim", "Automation editing is not exposed in this first production slice."),
  ];
}

function routingSettings(
  state: CockpitState,
  data: CockpitData,
  theme: Theme,
  width: number,
) {
  const list = [section(theme, "MODEL ROUTING"), ""];
  data.routes.forEach((rule, index) => {
    const marker = index === state.ruleIndex ? theme.fg("accent", "›") : " ";
    list.push(`${marker} ${rule.enabled ? theme.fg("success", "●") : theme.fg("dim", "○")} ${rule.name}`);
    list.push(`    ${theme.fg("dim", rule.when)}`);
  });
  const simulatorSelected = state.ruleIndex === data.routes.length;
  list.push(
    "",
    `${simulatorSelected ? theme.fg("accent", "›") : " "} ${simulatorSelected ? theme.bold("Test routing…") : "Test routing…"}`,
  );
  const rule = data.routes[state.ruleIndex];
  const detail = simulatorSelected
    ? [
        section(theme, "ROUTING SIMULATOR"),
        theme.bold("Test representative ticket traits"),
        "",
        "See which ordered rule matches and inspect the final runtime, model, effort, and profile.",
        "",
        theme.fg("dim", "Press Enter to open the simulator."),
      ]
    : [
        section(theme, "RESOLVED TARGET"),
        theme.bold(rule?.name ?? "Routing rule"),
        "",
        `When      ${rule?.when ?? ""}`,
        `Runtime   ${rule?.runtime ?? ""}`,
        `Model     ${rule?.model ?? ""}`,
        `Effort    ${rule?.effort ?? ""}`,
        `Profile   ${rule?.profile ?? ""}`,
        "",
        section(theme, "FAILURE BEHAVIOR"),
        "Stop and create an attention item",
        "No implicit model fallback",
        "",
        theme.fg("dim", "Press Enter to edit this rule."),
      ];
  if (width >= 82) return columns(list, detail, width, Math.floor(width * 0.45), theme);
  return [...list, "", ...detail];
}

function trackerSettings(
  state: CockpitState,
  data: CockpitData,
  theme: Theme,
  width: number,
) {
  const tracker = data.trackers[state.trackerIndex]!;
  const aligned = tracker.id === data.configuredTrackerId;
  const jiraBoard =
    tracker.id === "jira"
      ? data.jiraBoards?.[state.jiraBoardIndex]
      : undefined;
  const list = [section(theme, "ISSUE TRACKER"), ""];
  data.trackers.forEach((item, index) => {
    const selected = index === state.trackerIndex;
    list.push(`${selected ? theme.fg("accent", "›") : " "} ${selected ? theme.bold(item.label) : item.label}`);
    list.push(`    ${theme.fg("dim", item.auth)}`);
  });
  if (tracker.id === "jira") {
    list.push("", section(theme, "JIRA BOARD"));
    if (data.jiraBoards?.length) {
      data.jiraBoards.forEach((board, index) => {
        const selected = index === state.jiraBoardIndex;
        const applied = board.id === data.configuredJiraBoardId;
        list.push(
          `${selected ? theme.fg("accent", "›") : " "} ${applied ? theme.fg("success", "✓") : " "} ${selected ? theme.bold(board.name) : board.name}`,
        );
        list.push(`      ${theme.fg("dim", `${board.location} · ${board.type}`)}`);
      });
      list.push("", theme.fg("dim", "Use ←/→ to select a Jira board."));
    } else {
      list.push(theme.fg("warning", "  Boards are loading or unavailable."));
    }
  }
  const detail = [
    section(theme, "ADAPTER PREVIEW"),
    theme.bold(tracker.label),
    "",
    `Wayfinder skill       ${theme.fg("success", "● configured")}`,
    `Tracker instructions  ${tracker.instructions}`,
    `Repository / project  ${jiraBoard?.projectKeys.join(", ") || tracker.repositoryLabel}`,
    ...(tracker.id === "jira"
      ? [`Jira board            ${jiraBoard?.name ?? "No board available"}`]
      : []),
    `Configuration status  ${aligned ? theme.fg("success", "● aligned") : theme.fg("warning", "● differs from repository instructions")}`,
    "",
    section(theme, "CAPABILITIES"),
    ...tracker.capabilities.map(
      (capability) =>
        `  ${capability.available ? theme.fg("success", "●") : theme.fg("muted", "○")} ${capability.label} · ${capability.value}`,
    ),
    "",
    theme.fg("dim", `Press Enter to persist this tracker${tracker.id === "jira" ? " and board" : ""}.`),
    theme.fg("dim", "Credentials remain in the provider CLI or environment."),
  ];
  if (width >= 82) return columns(list, detail, width, Math.floor(width * 0.4), theme);
  return [...list, "", ...detail];
}

function settingsScreen(
  state: CockpitState,
  data: CockpitData,
  theme: Theme,
  width: number,
) {
  return settingsMenu(state, data, theme, width);
}

function targetEditor(
  state: CockpitState,
  data: CockpitData,
  theme: Theme,
  width: number,
) {
  const rule = state.draftRule!;
  const runtime =
    data.agentCatalog.find((candidate) => candidate.id === rule.runtime) ??
    data.agentCatalog[0]!;
  const model =
    runtime.models.find((candidate) => candidate.id === rule.model) ??
    runtime.models[0];
  const fields = [
    ["Runtime", runtime.id],
    ["Model", model?.label ?? "No available models"],
    ["Effort", rule.effort],
    ["Profile", rule.profile],
  ];
  const list = [
    theme.bold(
      `${state.screen === "agent-editor" ? "Edit default" : "Edit route"} · ${rule.name}`,
    ),
    theme.fg("dim", `Match: ${rule.when}`),
    "",
    ...fields.map(([label, value], index) => {
      const selected = index === state.ruleField;
      return `${selected ? theme.fg("accent", "›") : " "} ${pad(label, 12)} ${selected ? theme.bold(`‹ ${value} ›`) : value}`;
    }),
    "",
    theme.fg("dim", "Use ←/→ to change the selected value."),
  ];
  const detail = [
    section(theme, "CAPABILITY CONSTRAINTS"),
    `${theme.bold(runtime.id)}  ${runtime.models.length} available model${runtime.models.length === 1 ? "" : "s"}`,
    theme.fg("dim", runtime.source),
    "",
    `Model       ${model?.label ?? "unavailable"}`,
    `Model ID    ${model?.id ?? "unavailable"}`,
    `Efforts     ${model?.efforts.join(" · ") || "none"}`,
    `Default     ${model?.defaultEffort ?? "none"}`,
    "",
    section(theme, "RESOLVED SPAWN PREVIEW"),
    `Runtime     ${rule.runtime}`,
    `Model       ${rule.model}`,
    `Effort      ${rule.effort}`,
    `Profile     ${rule.profile}`,
    "",
    theme.fg("dim", "Enter persists this target for the current workspace."),
  ];
  if (width >= 82) return columns(list, detail, width, Math.floor(width * 0.45), theme);
  return [...list, "", ...detail];
}

function simulatorScreen(state: CockpitState, data: CockpitData, theme: Theme) {
  const samples = [
    {
      title: "Research accessible navigation patterns",
      traits: "research · AFK · UI · web",
      rule: data.routes[0]!,
    },
    {
      title: "Collect framework compatibility data",
      traits: "research · AFK · web · long",
      rule: data.routes[1]!,
    },
    {
      title: "Implement local Markdown adapter",
      traits: "task · AFK · code",
      rule: data.routes[2]!,
    },
  ];
  const sample = samples[state.simulatorIndex]!;
  return [
    theme.bold("Routing simulator"),
    theme.fg("dim", "Use ↑/↓ to try representative ticket traits."),
    "",
    ...samples.map((item, index) =>
      `${index === state.simulatorIndex ? theme.fg("accent", "›") : " "} ${item.title}`,
    ),
    "",
    section(theme, "NORMALIZED TICKET"),
    `Title     ${sample.title}`,
    `Traits    ${sample.traits}`,
    "",
    section(theme, "MATCH EXPLANATION"),
    `${theme.fg("success", "●")} First matching rule: ${theme.bold(sample.rule.name)}`,
    `  ${sample.rule.when}`,
    "",
    section(theme, "FINAL RUN SPEC"),
    `Runtime   ${sample.rule.runtime}`,
    `Model     ${sample.rule.model}`,
    `Effort    ${sample.rule.effort}`,
    `Profile   ${sample.rule.profile}`,
    `Fallback  stop and notify`,
  ];
}

function breadcrumbs(state: CockpitState, data: CockpitData) {
  const map = selectedMap(state, data);
  if (state.screen === "maps") return "All maps";
  if (state.screen === "map") return `Maps / ${map.title}`;
  if (state.screen === "ticket") return `Maps / ${map.title} / ${state.selectedTicketId}`;
  if (state.screen === "map-context") return `Maps / ${map.title} / Full context`;
  if (state.screen === "attention") return "Attention / Discoveries";
  if (state.screen === "agents") return "Agent activity";
  if (state.screen === "settings") return "Settings";
  if (state.screen === "delivery-settings") return "Settings / Delivery workflow";
  if (state.screen === "agent-settings") return "Settings / Agent defaults";
  if (state.screen === "routing-settings") return "Settings / Model routing";
  if (state.screen === "tracker-settings") return "Settings / Issue tracker";
  if (state.screen === "automation-settings") return "Settings / Automation & safety";
  if (state.screen === "agent-editor") return "Settings / Agent defaults / Edit target";
  if (state.screen === "rule-editor") return "Settings / Model routing / Edit";
  return "Settings / Model routing / Simulator";
}

function footer(state: CockpitState) {
  if (state.screen === "maps") return "↑↓ select · enter open · g agents · s settings · q close";
  if (state.screen === "map") return "↑↓ select · enter ticket · c context · g agents · s settings · esc back";
  if (state.screen === "ticket") return "r details · n start · j join · x cancel · g agents · ↑↓ scroll · esc back";
  if (state.screen === "map-context") return "↑↓/PgUp/PgDn scroll · esc back · q close";
  if (state.screen === "attention") return "↑↓ select · a accept · f Fog · d dismiss · esc back · q close";
  if (state.screen === "agents") return "↑↓ select · enter open/join · x cancel agent · m maps · esc back · q close";
  if (state.screen === "settings") return "↑↓ select · enter open · esc back · q close";
  if (state.screen === "delivery-settings") return "↑↓ select · enter apply · esc back · q close";
  if (state.screen === "agent-settings") return "↑↓ select · enter edit · esc back · q close";
  if (state.screen === "routing-settings") return "↑↓ select · enter open · esc back · q close";
  if (state.screen === "tracker-settings") return "↑↓ tracker · ←→ Jira board · enter apply · esc back · q close";
  if (state.screen === "automation-settings") return "↑↓ select · enter edit · esc back · q close";
  if (state.screen === "rule-editor" || state.screen === "agent-editor") return "↑↓ field · ←→ allowed value · enter accept · esc cancel";
  if (state.screen === "simulator") return "↑↓ sample · esc back · q close";
  return "esc back · q close";
}

export function renderCockpit(
  state: CockpitState,
  data: CockpitData,
  theme: Theme,
  width: number,
  bodyHeight = MAX_BODY_LINES,
) {
  const panelWidth = Math.max(48, width);
  const innerWidth = panelWidth - 2;
  let content: string[];
  const waitingForFirstLoad =
    state.screen === "maps" &&
    data.trackerRefresh?.state === "loading" &&
    data.trackerRefresh.updatedAt === undefined;
  if (waitingForFirstLoad) {
    content = [
      section(theme, "MAPS"),
      "",
      theme.fg("accent", "Loading repository map roots…"),
      theme.fg("dim", "The cockpit is open; tracker data will appear as it arrives."),
    ];
  } else if (state.screen === "maps" && data.maps.length === 0) {
    const message = data.trackerRefresh?.error ??
      "No epic or Wayfinder map roots were found for this repository.";
    content = [
      section(theme, "NO MAPS AVAILABLE"),
      "",
      ...wrap(message, Math.max(24, innerWidth - 2)).map((line) =>
        theme.fg(data.trackerRefresh?.state === "error" ? "warning" : "text", line),
      ),
      "",
      theme.fg("dim", "Wayfinder remains inactive until this repository is configured."),
    ];
  } else if (state.screen === "maps") content = mapPicker(state, data, theme, innerWidth);
  else if (state.screen === "map") content = mapBoard(state, data, theme, innerWidth);
  else if (state.screen === "ticket") content = ticketScreen(state, data, theme, innerWidth);
  else if (state.screen === "map-context") content = mapContextScreen(state, data, theme, innerWidth);
  else if (state.screen === "attention") content = attentionScreen(state, data, theme, innerWidth);
  else if (state.screen === "agents") content = agentsScreen(state, data, theme, innerWidth);
  else if (state.screen === "settings") content = settingsScreen(state, data, theme, innerWidth);
  else if (state.screen === "delivery-settings") content = deliverySettings(state, data, theme, innerWidth);
  else if (state.screen === "agent-settings") content = agentSettings(state, data, theme, innerWidth);
  else if (state.screen === "routing-settings") content = routingSettings(state, data, theme, innerWidth);
  else if (state.screen === "tracker-settings") content = trackerSettings(state, data, theme, innerWidth);
  else if (state.screen === "automation-settings") content = automationSettings(state, theme);
  else if (state.screen === "rule-editor" || state.screen === "agent-editor") content = targetEditor(state, data, theme, innerWidth);
  else content = simulatorScreen(state, data, theme);

  const title = " WAYFINDER COCKPIT ";
  const titleWidth = visibleWidth(title);
  const row = (value = "") =>
    `${theme.fg("border", "│")}${pad(value, innerWidth)}${theme.fg("border", "│")}`;
  const lines = [
    `${theme.fg("border", "╭")}${theme.fg("accent", title)}${theme.fg("border", `${"─".repeat(Math.max(0, innerWidth - titleWidth))}╮`)}`,
    row(` ${theme.fg("dim", breadcrumbs(state, data))}`),
    row(theme.fg("borderMuted", "─".repeat(innerWidth))),
  ];
  const visibleContent = content.slice(0, bodyHeight);
  for (const line of visibleContent) lines.push(row(` ${line}`));
  for (let index = visibleContent.length; index < bodyHeight; index++) {
    lines.push(row());
  }
  lines.push(
    row(state.notice ? ` ${theme.fg("warning", fit(state.notice, innerWidth - 2))}` : ""),
    row(""),
    row(` ${theme.fg("dim", footer(state))}`),
    `${theme.fg("border", "╰")}${theme.fg("border", "─".repeat(innerWidth))}${theme.fg("border", "╯")}`,
  );
  return lines;
}
