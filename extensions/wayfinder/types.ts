export type TicketType = "research" | "prototype" | "grilling" | "task";
export type WorkMode = "AFK" | "HITL";
export type AgentRuntimeId = "Pi" | "Claude" | "Codex";
export type ReasoningEffort =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export type TrackerState = "open" | "claimed" | "resolved" | "migrated";
export type AgentState = "queued" | "running" | "failed" | "complete";
export type ReviewState =
  | "draft"
  | "open"
  | "review-required"
  | "changes-requested"
  | "approved"
  | "merged";
export type MapOutcome = "specification" | "implemented" | "deployed";

export interface IssueComment {
  author: string;
  body: string;
  createdAt: string;
  url?: string;
}

export interface DependencyRef {
  id: string;
  title: string;
  state: "open" | "closed";
}

export interface TrackerReference {
  provider: "github" | "gitlab" | "jira" | "linear" | "markdown" | "custom";
  id: string;
  url: string;
  canonical: boolean;
}

export interface MapSection {
  heading: string;
  body: string;
  items: string[];
}

export interface Ticket {
  id: string;
  title: string;
  question: string;
  body?: string;
  url?: string;
  labels?: string[];
  assignees?: string[];
  comments?: IssueComment[];
  commentCount?: number;
  dependencies?: DependencyRef[];
  hydrated?: boolean;
  hydrating?: boolean;
  source?: TrackerReference;
  mirror?: TrackerReference;
  type: TicketType;
  mode: WorkMode;
  domains: string[];
  capabilities: string[];
  trackerState: TrackerState;
  assignee?: string;
  blockedBy: string[];
  agent?: {
    runtime: AgentRuntimeId;
    model: string;
    effort: ReasoningEffort;
    state: AgentState;
  };
  workspace?: {
    branch: string;
    path: string;
    dirty?: boolean;
  };
  review?: {
    number: number;
    title?: string;
    url?: string;
    branch?: string;
    state: ReviewState;
    checks: "pending" | "passing" | "failing";
  };
  attention?: "discovery" | "result" | "needs-input" | "failed";
}

export interface WayfinderMap {
  id: string;
  kind?: "wayfinder" | "epic";
  repository: string;
  title: string;
  destination: string;
  body?: string;
  url?: string;
  labels?: string[];
  comments?: IssueComment[];
  source?: TrackerReference;
  mirror?: TrackerReference;
  sections?: MapSection[];
  notes: string[];
  decisions?: string[];
  fog: string[];
  outOfScope?: string[];
  updated: string;
  state: "open" | "closed";
  autoRun: boolean;
  outcome: MapOutcome;
  tickets: Ticket[];
  activity: string[];
}

export interface DiscoveryProposal {
  id: string;
  mapId: string;
  sourceTicketId: string;
  kind: "prerequisite" | "follow-up" | "fog";
  title: string;
  rationale: string;
  suggestedType: TicketType;
  suggestedMode: WorkMode;
  suggestedDomains: string[];
  suggestedCapabilities: string[];
}

export interface AgentTarget {
  runtime: AgentRuntimeId;
  model: string;
  effort: ReasoningEffort;
  profile: "scout" | "researcher" | "worker";
}

export interface AgentModelOption {
  id: string;
  label: string;
  efforts: ReasoningEffort[];
  defaultEffort: ReasoningEffort;
}

export interface AgentRuntimeOption {
  id: AgentRuntimeId;
  source: string;
  models: AgentModelOption[];
}

export interface RoutingRule {
  id: string;
  name: string;
  when: string;
  runtime: AgentRuntimeId;
  model: string;
  effort: ReasoningEffort;
  profile: "scout" | "researcher" | "worker";
  enabled: boolean;
}

export interface DeliveryProfile {
  id: "spec-handoff" | "team-reviewed" | "solo-guarded" | "direct-delivery";
  label: string;
  outcome: MapOutcome;
  approval: string;
  quality: string[];
  integration: string;
  release: string;
  waitingLabel: string;
}

export interface TrackerProfile {
  id: "github" | "gitlab" | "jira" | "linear" | "markdown" | "custom";
  label: string;
  repositoryLabel: string;
  instructions: string;
  auth: string;
  capabilities: Array<{ label: string; value: string; available: boolean }>;
}

export interface JiraBoardOption {
  id: string;
  name: string;
  type: string;
  location: string;
  projectKeys: string[];
}

export interface WayfinderRun {
  id: string;
  mapId: string;
  ticketId: string;
  title: string;
  backend: AgentRuntimeId;
  model?: string;
  effort?: ReasoningEffort;
  profile: "scout" | "researcher" | "worker";
  cwd: string;
  status: "running" | "done" | "error" | "archived";
  createdAt: number;
  updatedAt: number;
  ownerPid?: number;
  sessionFilePath?: string;
  nativeSessionId?: string;
  finalText?: string;
}

export interface CockpitData {
  maps: WayfinderMap[];
  discoveries: DiscoveryProposal[];
  routes: RoutingRule[];
  agentCatalog: AgentRuntimeOption[];
  deliveryProfiles: DeliveryProfile[];
  trackers: TrackerProfile[];
  runs?: WayfinderRun[];
  agentDefaults?: { HITL: AgentTarget; AFK: AgentTarget };
  configuredDeliveryProfileId?: string;
  configuredTrackerId?: string;
  jiraBoards?: JiraBoardOption[];
  configuredJiraBoardId?: string;
  settingsPath?: string;
  settingsPersisted?: boolean;
  trackerRefresh?: {
    state: "loading" | "refreshing" | "current" | "error";
    updatedAt?: number;
    error?: string;
  };
}
