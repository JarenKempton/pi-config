import { execFile } from "node:child_process";
import type {
  CockpitData,
  DependencyRef,
  MapOutcome,
  Ticket,
  TicketType,
  TrackerProfile,
  WayfinderMap,
} from "./types.ts";

interface JiraNamedField {
  id?: string;
  key?: string;
  name?: string;
  displayName?: string;
}

interface JiraIssueLink {
  type?: { name?: string; inward?: string; outward?: string };
  inwardIssue?: JiraWorkItem;
  outwardIssue?: JiraWorkItem;
}

export interface JiraWorkItem {
  id?: string;
  key: string;
  self?: string;
  fields?: {
    summary?: string;
    description?: unknown;
    status?: JiraNamedField & { statusCategory?: JiraNamedField };
    assignee?: JiraNamedField;
    issuetype?: JiraNamedField & { subtask?: boolean };
    labels?: string[];
    updated?: string;
    parent?: JiraWorkItem;
    issuelinks?: JiraIssueLink[];
  };
}

type AcliRunner = (args: string[], cwd: string) => Promise<string>;

const DEFAULT_MAP_JQL =
  'issuetype = Epic AND statusCategory != Done ORDER BY updated DESC';
// ACLI search accepts a smaller field set than `workitem view`; requesting
// updated, parent, or issuelinks makes the entire search fail.
const SEARCH_FIELDS =
  "key,summary,description,status,assignee,issuetype,labels";

function runAcli(args: string[], cwd: string) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "acli",
      args,
      { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr).trim() || error.message;
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            reject(
              new Error(
                "Jira Wayfinder requires Atlassian CLI (`acli`). Install it and run `acli jira auth login`, then reopen /wayfinder.",
              ),
            );
            return;
          }
          reject(new Error(detail));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function parseJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(
      `Atlassian CLI returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function jiraWorkItems(value: unknown): JiraWorkItem[] {
  if (Array.isArray(value)) return value as JiraWorkItem[];
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of ["issues", "workItems", "values", "data"]) {
    if (Array.isArray(record[key])) return record[key] as JiraWorkItem[];
  }
  return "key" in record ? [record as unknown as JiraWorkItem] : [];
}

function adfText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(adfText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const node = value as { text?: unknown; content?: unknown; type?: unknown };
  if (typeof node.text === "string") return node.text;
  const content = adfText(node.content);
  return node.type === "paragraph" && content ? `${content}\n` : content;
}

function firstParagraph(value: string, fallback: string) {
  return value
    .split(/\n\s*\n|\n/)
    .map((paragraph) => paragraph.trim())
    .find(Boolean) ?? fallback;
}

function relativeTime(timestamp: string | undefined) {
  if (!timestamp) return "unknown";
  const delta = Math.max(0, Date.now() - Date.parse(timestamp));
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

function browseUrl(issue: JiraWorkItem) {
  if (!issue.self) return undefined;
  try {
    const url = new URL(issue.self);
    return `${url.origin}/browse/${issue.key}`;
  } catch {
    return undefined;
  }
}

function resolved(issue: JiraWorkItem) {
  const category = issue.fields?.status?.statusCategory;
  const value = `${category?.key ?? ""} ${category?.name ?? ""}`.toLowerCase();
  return value.includes("done") || value.includes("complete");
}

function ticketType(issue: JiraWorkItem): TicketType {
  const labels = issue.fields?.labels?.map((label) => label.toLowerCase()) ?? [];
  if (labels.includes("research")) return "research";
  if (labels.includes("prototype")) return "prototype";
  if (labels.includes("grilling")) return "grilling";
  return "task";
}

function dependencyRefs(issue: JiraWorkItem): DependencyRef[] {
  const dependencies: DependencyRef[] = [];
  for (const link of issue.fields?.issuelinks ?? []) {
    const type = link.type?.name?.toLowerCase() ?? "";
    const inward = link.inwardIssue;
    const outward = link.outwardIssue;
    const blocker = type.includes("block") ? inward : undefined;
    if (!blocker) continue;
    dependencies.push({
      id: blocker.key,
      title: blocker.fields?.summary ?? "Jira dependency",
      state: resolved(blocker) ? "closed" : "open",
    });
    if (outward?.key === issue.key) continue;
  }
  return dependencies;
}

function ticketFromJira(issue: JiraWorkItem): Ticket {
  const body = adfText(issue.fields?.description);
  const type = ticketType(issue);
  const dependencies = dependencyRefs(issue);
  const assignee = issue.fields?.assignee?.displayName ?? issue.fields?.assignee?.name;
  const url = browseUrl(issue);
  return {
    id: issue.key,
    title: issue.fields?.summary ?? issue.key,
    question: firstParagraph(body, "No Jira description recorded."),
    body,
    url,
    labels: issue.fields?.labels ?? [],
    assignees: assignee ? [assignee] : [],
    dependencies,
    hydrated: true,
    source: {
      provider: "jira",
      id: issue.key,
      url: url ?? issue.self ?? issue.key,
      canonical: true,
    },
    type,
    mode: type === "research" ? "AFK" : "HITL",
    domains: [],
    capabilities: ["code"],
    trackerState: resolved(issue) ? "resolved" : assignee ? "claimed" : "open",
    assignee,
    blockedBy: dependencies
      .filter((dependency) => dependency.state === "open")
      .map((dependency) => dependency.id),
    comments: [],
    commentCount: 0,
  };
}

function inferOutcome(description: string): MapOutcome {
  const value = description.toLowerCase();
  if (value.includes("plan-only") || value.includes("specification")) {
    return "specification";
  }
  if (value.includes("deploy") || value.includes("production rollout")) {
    return "deployed";
  }
  return "implemented";
}

export function mapFromJira(root: JiraWorkItem, children: JiraWorkItem[]): WayfinderMap {
  const body = adfText(root.fields?.description);
  const tickets = children.map(ticketFromJira);
  const url = browseUrl(root);
  return {
    id: `jira:${root.key}`,
    kind: "epic",
    repository: root.key.split("-")[0] ?? "Jira",
    title: root.fields?.summary ?? root.key,
    destination: firstParagraph(body, "No Jira epic description recorded."),
    body,
    url,
    labels: root.fields?.labels ?? [],
    source: {
      provider: "jira",
      id: root.key,
      url: url ?? root.self ?? root.key,
      canonical: true,
    },
    notes: [],
    decisions: [],
    fog: [],
    outOfScope: [],
    updated: relativeTime(root.fields?.updated),
    state: resolved(root) ? "closed" : "open",
    autoRun: false,
    outcome: inferOutcome(body),
    tickets,
    activity: children
      .slice()
      .sort(
        (left, right) =>
          Date.parse(right.fields?.updated ?? "") - Date.parse(left.fields?.updated ?? ""),
      )
      .slice(0, 5)
      .map(
        (issue) =>
          `${relativeTime(issue.fields?.updated)}  ${issue.key} ${issue.fields?.status?.name ?? "updated"}`,
      ),
  };
}

function jiraTrackers(defaults: CockpitData, maps: WayfinderMap[]): TrackerProfile[] {
  const existing = defaults.trackers.find((tracker) => tracker.id === "jira")!;
  const projects = [...new Set(maps.map((map) => map.repository))].join(", ");
  const configured: TrackerProfile = {
    ...existing,
    repositoryLabel: projects || "Jira",
    auth: "Atlassian CLI authenticated · live read-only data",
  };
  return [configured, ...defaults.trackers.filter((tracker) => tracker.id !== "jira")];
}

async function search(jql: string, cwd: string, runner: AcliRunner) {
  const output = await runner(
    [
      "jira",
      "workitem",
      "search",
      "--jql",
      jql,
      "--fields",
      SEARCH_FIELDS,
      "--paginate",
      "--json",
    ],
    cwd,
  );
  return jiraWorkItems(parseJson(output));
}

export async function loadJiraWayfinderData(
  cwd: string,
  defaults: CockpitData,
  runner: AcliRunner = runAcli,
): Promise<CockpitData> {
  await runner(["jira", "auth", "status"], cwd);
  const mapJql = process.env.WAYFINDER_JIRA_MAP_JQL?.trim() || DEFAULT_MAP_JQL;
  const roots = await search(mapJql, cwd, runner);
  const maps = await Promise.all(
    roots.map(async (root) =>
      mapFromJira(root, await search(`parent = ${root.key} ORDER BY rank`, cwd, runner)),
    ),
  );
  if (!maps.length) {
    throw new Error(
      `No Jira epics matched Wayfinder's map query: ${mapJql}. Set WAYFINDER_JIRA_MAP_JQL to the JQL for your map roots.`,
    );
  }
  return {
    ...defaults,
    maps,
    discoveries: [],
    trackers: jiraTrackers(defaults, maps),
  };
}
