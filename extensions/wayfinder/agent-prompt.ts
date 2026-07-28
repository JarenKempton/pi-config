import type { Ticket, WayfinderMap } from "./types.ts";

function skillFor(ticket: Ticket) {
  if (ticket.type === "research") return "Use the research skill and resolve the research question.";
  if (ticket.type === "prototype") return "Use the prototype skill to answer the design question with a disposable artifact.";
  if (ticket.type === "grilling") return "Use the grilling and domain-modeling skills to sharpen and resolve the decision.";
  return "Investigate the ticket, plan the work, and execute only within the ticket's stated scope.";
}

export function buildAgentPrompt(map: WayfinderMap, ticket: Ticket) {
  const mapContext = (map.body || map.destination).slice(0, 14_000);
  const ticketContext = (ticket.body || ticket.question).slice(0, 14_000);
  return `You are working one ticket inside a Wayfinder map.

MAP
${map.id}
${map.title}

MAP CONTEXT
${mapContext}

TICKET
${ticket.id} ${ticket.title}
Canonical tracker: ${ticket.source?.provider ?? "unknown"}
Tracker status: ${ticket.trackerStatus ?? ticket.trackerState}
Parent: ${ticket.parentId ?? "map root"}
Hierarchy role: ${ticket.hasChildren ? "execution parent" : "claimable leaf"}
Type: ${ticket.type}
Mode: ${ticket.mode}
Open blockers: ${ticket.blockedBy.join(", ") || "none"}

TICKET CONTEXT
${ticketContext}

INSTRUCTIONS
${skillFor(ticket)}
Stay inside the map's declared territory. Treat the ticket's canonical tracker as the only execution source of truth. When the canonical tracker is Jira, GitHub Wayfinder issues are historical evidence only: cite useful evidence, but never infer current status, assignment, blockers, or completion from GitHub. Do not create, edit, close, or comment on tracker issues yourself; the parent cockpit owns tracker mutations and must write verified progress back to Jira. Do not broaden permissions. If you discover another question, report it instead of silently expanding scope.

End with:
1. Answer or implementation summary.
2. Evidence and verification.
3. Discoveries, each classified as prerequisite, follow-up, or Fog.
4. Whether this ticket is resolved, blocked, or needs human input.
`;
}
