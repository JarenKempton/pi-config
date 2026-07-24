import type { WorkspaceSettings } from "./config.ts";
import type {
  AgentRuntimeOption,
  AgentTarget,
  RoutingRule,
  Ticket,
} from "./types.ts";

function matches(rule: RoutingRule, ticket: Ticket) {
  const condition = rule.when.toLowerCase();
  const facts = new Set([
    ticket.type.toLowerCase(),
    ticket.mode.toLowerCase(),
    ...ticket.domains.map((value) => `domain:${value.toLowerCase()}`),
    ...ticket.capabilities.map((value) => `capability:${value.toLowerCase()}`),
  ]);
  const requirements = condition
    .split("·")
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => !value.startsWith("duration:"));
  return requirements.every((requirement) => facts.has(requirement));
}

export function constrainAgentTarget(
  target: AgentTarget,
  catalog: AgentRuntimeOption[],
): AgentTarget {
  const availableRuntimes = catalog.filter((runtime) => runtime.models.length > 0);
  const runtime =
    availableRuntimes.find((candidate) => candidate.id === target.runtime) ??
    availableRuntimes[0];
  if (!runtime) return target;
  const model =
    runtime.models.find((candidate) => candidate.id === target.model) ??
    runtime.models[0]!;
  return {
    ...target,
    runtime: runtime.id,
    model: model.id,
    effort: model.efforts.includes(target.effort)
      ? target.effort
      : model.defaultEffort,
  };
}

export function resolveAgentTarget(
  ticket: Ticket,
  settings: WorkspaceSettings,
): AgentTarget {
  const rule = settings.routes.find((candidate) => candidate.enabled && matches(candidate, ticket));
  if (rule) {
    return {
      runtime: rule.runtime,
      model: rule.model,
      effort: rule.effort,
      profile: rule.profile,
    };
  }
  return { ...settings.agentDefaults[ticket.mode] };
}
