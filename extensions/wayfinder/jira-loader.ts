import { execFile } from "node:child_process";
import type {
  CockpitData,
  DependencyRef,
  IssueComment,
  JiraBoardOption,
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

interface JiraComment {
  author?: JiraNamedField;
  body?: unknown;
  created?: string;
  self?: string;
}

interface AcliBoard {
  id: string | number;
  name?: string;
  type?: string;
  location?: string;
}

interface AcliProject {
  key?: string;
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
    comment?: { comments?: JiraComment[]; total?: number };
  };
}

type AcliRunner = (args: string[], cwd: string) => Promise<string>;

const DEFAULT_MAP_JQL =
  'issuetype = Epic AND statusCategory != Done ORDER BY updated DESC';
// ACLI search accepts a smaller field set than `workitem view`; requesting
// updated, parent, or issuelinks makes the entire search fail. Search discovers
// keys cheaply, then `workitem view *all` hydrates canonical status/hierarchy.
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
                "Jira Wayfinder requires Atlassian CLI (`acli`). Install it and run `acli auth login`, then reopen /wayfinder.",
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

function arrayField<T>(value: unknown, keys: string[]): T[] {
  if (Array.isArray(value)) return value as T[];
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key] as T[];
  }
  return [];
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

function siteOrigin(authStatus: string) {
  const site = authStatus.match(/^\s*Site:\s*(\S+)\s*$/im)?.[1];
  if (!site) return undefined;
  return site.startsWith("http") ? site.replace(/\/$/, "") : `https://${site}`;
}

function browseUrl(issue: JiraWorkItem, origin?: string) {
  if (origin) return `${origin}/browse/${issue.key}`;
  if (!issue.self) return undefined;
  try {
    const url = new URL(issue.self);
    return `${url.origin}/browse/${issue.key}`;
  } catch {
    return undefined;
  }
}

function normalizedStatus(issue: JiraWorkItem) {
  return issue.fields?.status?.name?.trim() ?? "Unknown";
}

function normalizedStatusCategory(issue: JiraWorkItem) {
  const category = issue.fields?.status?.statusCategory;
  return (category?.key ?? category?.name ?? "").trim();
}

function resolved(issue: JiraWorkItem) {
  const value = `${normalizedStatus(issue)} ${normalizedStatusCategory(issue)}`.toLowerCase();
  return /done|complete|resolved|closed/.test(value);
}

function blockedStatus(issue: JiraWorkItem) {
  return /blocked|impediment|waiting/.test(normalizedStatus(issue).toLowerCase());
}

function trackerState(issue: JiraWorkItem): Ticket["trackerState"] {
  if (resolved(issue)) return "resolved";
  if (blockedStatus(issue)) return "open";
  const category = normalizedStatusCategory(issue).toLowerCase();
  const status = normalizedStatus(issue).toLowerCase();
  if (category.includes("progress") || category === "indeterminate") return "claimed";
  if (/in progress|review|testing|implementing|active/.test(status)) return "claimed";
  return "open";
}

function ticketType(issue: JiraWorkItem): TicketType {
  const labels = issue.fields?.labels?.map((label) => label.toLowerCase()) ?? [];
  const typed = labels
    .map((label) => label.replace(/^wayfinder:/, ""))
    .find((label) => ["research", "prototype", "grilling", "task"].includes(label));
  if (typed === "research" || typed === "prototype" || typed === "grilling") {
    return typed;
  }
  return "task";
}

function dependencyRefs(issue: JiraWorkItem): DependencyRef[] {
  const dependencies: DependencyRef[] = [];
  for (const link of issue.fields?.issuelinks ?? []) {
    const type = link.type?.name?.toLowerCase() ?? "";
    // In Jira's issue-link payload, when the viewed issue is on the
    // "is blocked by" side, the blocking work item is exposed as outwardIssue.
    const blocker = type.includes("block") ? link.outwardIssue : undefined;
    if (!blocker) continue;
    dependencies.push({
      id: blocker.key,
      title: blocker.fields?.summary ?? "Jira dependency",
      state: resolved(blocker) ? "closed" : "open",
    });
  }
  return dependencies;
}

function jiraComments(issue: JiraWorkItem): IssueComment[] {
  return (issue.fields?.comment?.comments ?? []).map((comment) => ({
    author:
      comment.author?.displayName ??
      comment.author?.name ??
      comment.author?.key ??
      "unknown",
    body: adfText(comment.body),
    createdAt: comment.created ?? "",
    url: comment.self,
  }));
}

function ticketFromJira(
  issue: JiraWorkItem,
  origin?: string,
  hierarchyLevel = 1,
): Ticket {
  const body = adfText(issue.fields?.description);
  const type = ticketType(issue);
  const dependencies = dependencyRefs(issue);
  const assignee = issue.fields?.assignee?.displayName ?? issue.fields?.assignee?.name;
  const url = browseUrl(issue, origin);
  const comments = jiraComments(issue);
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
    trackerState: trackerState(issue),
    trackerStatus: normalizedStatus(issue),
    trackerStatusCategory: normalizedStatusCategory(issue),
    parentId: issue.fields?.parent?.key,
    hierarchyLevel,
    updatedAt: issue.fields?.updated,
    assignee,
    blockedBy: dependencies
      .filter((dependency) => dependency.state === "open")
      .map((dependency) => dependency.id),
    comments,
    commentCount: issue.fields?.comment?.total ?? comments.length,
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

export function mapFromJira(
  root: JiraWorkItem,
  children: Array<{ issue: JiraWorkItem; depth?: number }> | JiraWorkItem[],
  origin?: string,
): WayfinderMap {
  const body = adfText(root.fields?.description);
  const normalizedChildren = children.map((entry) =>
    "issue" in entry ? entry : { issue: entry, depth: 1 },
  );
  const tickets = normalizedChildren.map(({ issue, depth }) =>
    ticketFromJira(issue, origin, depth ?? 1),
  );
  const parentKeys = new Set(tickets.flatMap((ticket) => ticket.parentId ? [ticket.parentId] : []));
  for (const ticket of tickets) ticket.hasChildren = parentKeys.has(ticket.id);
  const url = browseUrl(root, origin);
  return {
    id: `jira:${root.key}`,
    kind: "epic",
    repository: root.key.split("-")[0] ?? "Jira",
    title: root.fields?.summary ?? root.key,
    destination: firstParagraph(body, "No Jira epic description recorded."),
    body,
    url,
    labels: root.fields?.labels ?? [],
    comments: jiraComments(root),
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
    activity: normalizedChildren
      .slice()
      .sort(
        (left, right) =>
          Date.parse(right.issue.fields?.updated ?? "") -
          Date.parse(left.issue.fields?.updated ?? ""),
      )
      .slice(0, 5)
      .map(
        ({ issue }) =>
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
    auth: "Atlassian CLI authenticated · Jira is canonical",
  };
  return [configured, ...defaults.trackers.filter((tracker) => tracker.id !== "jira")];
}

export async function loadJiraBoards(
  cwd: string,
  runner: AcliRunner = runAcli,
): Promise<JiraBoardOption[]> {
  const boards = arrayField<AcliBoard>(
    parseJson(
      await runner(["jira", "board", "search", "--paginate", "--json"], cwd),
    ),
    ["values", "boards", "data"],
  );
  return Promise.all(
    boards.map(async (board) => {
      const projects = arrayField<AcliProject>(
        parseJson(
          await runner(
            [
              "jira",
              "board",
              "list-projects",
              "--id",
              String(board.id),
              "--paginate",
              "--json",
            ],
            cwd,
          ),
        ),
        ["projects", "values", "data"],
      );
      return {
        id: String(board.id),
        name: board.name ?? `Board ${board.id}`,
        type: board.type ?? "Jira",
        location: board.location ?? "Jira",
        projectKeys: projects.flatMap((project) =>
          project.key ? [project.key] : [],
        ),
      };
    }),
  );
}

function projectJql(projectKeys: string[]) {
  const projects = projectKeys
    .map((key) => `"${key.replaceAll('"', '\\"')}"`)
    .join(", ");
  return `project in (${projects})`;
}

function boardMapJql(board: JiraBoardOption | undefined) {
  if (!board) return DEFAULT_MAP_JQL;
  if (!board.projectKeys.length) {
    throw new Error(`Jira board ${board.name} has no associated projects.`);
  }
  return `${projectJql(board.projectKeys)} AND issuetype = Epic AND statusCategory != Done ORDER BY updated DESC`;
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

export async function transitionJiraTicket(
  cwd: string,
  ticketId: string,
  status: "To Do" | "In Progress",
  runner: AcliRunner = runAcli,
) {
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(ticketId)) {
    throw new Error(`Invalid Jira ticket id: ${ticketId}`);
  }
  await runner(
    [
      "jira",
      "workitem",
      "transition",
      "--key",
      ticketId,
      "--status",
      status,
      "--yes",
      "--json",
    ],
    cwd,
  );
}

async function view(key: string, cwd: string, runner: AcliRunner) {
  const output = await runner(
    ["jira", "workitem", "view", key, "--fields", "*all", "--json"],
    cwd,
  );
  const item = jiraWorkItems(parseJson(output))[0];
  if (!item) throw new Error(`Atlassian CLI returned no Jira work item for ${key}.`);
  return item;
}

async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function descendants(
  rootKey: string,
  ordered: JiraWorkItem[],
): Array<{ issue: JiraWorkItem; depth: number }> {
  const depthByKey = new Map<string, number>([[rootKey, 0]]);
  const remaining = new Set(ordered.map((issue) => issue.key));
  const result: Array<{ issue: JiraWorkItem; depth: number }> = [];
  let changed = true;
  while (changed && remaining.size) {
    changed = false;
    for (const issue of ordered) {
      if (!remaining.has(issue.key)) continue;
      const parent = issue.fields?.parent?.key;
      const parentDepth = parent ? depthByKey.get(parent) : undefined;
      if (parentDepth === undefined) continue;
      const depth = parentDepth + 1;
      depthByKey.set(issue.key, depth);
      remaining.delete(issue.key);
      result.push({ issue, depth });
      changed = true;
    }
  }
  return result;
}

export async function loadJiraWayfinderData(
  cwd: string,
  defaults: CockpitData,
  runner: AcliRunner = runAcli,
  boardId?: string,
): Promise<CockpitData> {
  const authStatus = await runner(["auth", "status"], cwd);
  const origin = siteOrigin(authStatus);
  const jiraBoards = await loadJiraBoards(cwd, runner);
  const configuredBoard = boardId
    ? jiraBoards.find((board) => board.id === boardId)
    : undefined;
  if (boardId && !configuredBoard) {
    throw new Error(
      `Configured Jira board ${boardId} is not available to the authenticated account.`,
    );
  }
  const mapJql =
    process.env.WAYFINDER_JIRA_MAP_JQL?.trim() || boardMapJql(configuredBoard);
  const rootSummaries = await search(mapJql, cwd, runner);
  if (!rootSummaries.length) {
    throw new Error(
      `No Jira epics matched Wayfinder's map query: ${mapJql}. Set WAYFINDER_JIRA_MAP_JQL to the JQL for your map roots.`,
    );
  }

  const projectKeys = configuredBoard?.projectKeys.length
    ? configuredBoard.projectKeys
    : [...new Set(rootSummaries.map((root) => root.key.split("-")[0]!))];
  const allSummaries = await search(`${projectJql(projectKeys)} ORDER BY rank`, cwd, runner);
  const keys = [...new Set([...rootSummaries, ...allSummaries].map((issue) => issue.key))];
  const hydrated = await mapConcurrent(keys, 8, (key) => view(key, cwd, runner));
  const byKey = new Map(hydrated.map((issue) => [issue.key, issue]));
  const roots = rootSummaries.map((root) => byKey.get(root.key) ?? root);
  const orderedChildren = allSummaries.flatMap((summary) => {
    const issue = byKey.get(summary.key);
    return issue ? [issue] : [];
  });
  const maps = roots.map((root) =>
    mapFromJira(root, descendants(root.key, orderedChildren), origin),
  );

  return {
    ...defaults,
    maps,
    discoveries: [],
    trackers: jiraTrackers(defaults, maps),
    jiraBoards,
    configuredJiraBoardId: configuredBoard?.id,
  };
}
