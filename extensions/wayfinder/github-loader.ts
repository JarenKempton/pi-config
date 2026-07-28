import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  DependencyRef,
  IssueComment,
  MapSection,
  CockpitData,
  ReviewState,
  Ticket,
  TicketType,
  TrackerProfile,
  TrackerReference,
  WayfinderMap,
} from "./types.ts";

interface RawIssue {
  number: number;
  title: string;
  body?: string;
  state: string;
  updatedAt?: string;
  updated_at?: string;
  url?: string;
  html_url?: string;
  labels?: Array<{ name?: string } | string>;
  assignees?: Array<{ login?: string } | string>;
  issue_dependencies_summary?: { blocked_by?: number };
  comments?: RawComment[] | number;
}

interface RawComment {
  author?: { login?: string };
  body?: string;
  createdAt?: string;
  url?: string;
}

interface RawPullRequest {
  number: number;
  title?: string;
  url?: string;
  state: string;
  isDraft: boolean;
  reviewDecision: string;
  reviewRequests: unknown[];
  headRefName: string;
  closingIssuesReferences: Array<{ number: number }>;
  statusCheckRollup: Array<{ status?: string; conclusion?: string }>;
}

interface LocalWorktree {
  path: string;
  branch: string;
}

function run(file: string, args: string[], cwd: string) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 30_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr).trim() || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function json<T>(file: string, args: string[], cwd: string): Promise<T> {
  const output = await run(file, args, cwd);
  return JSON.parse(output) as T;
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

function labels(issue: RawIssue) {
  return (issue.labels ?? [])
    .map((label) => (typeof label === "string" ? label : label.name ?? ""))
    .filter(Boolean);
}

function normalizeComments(comments: RawComment[] | number | undefined): IssueComment[] {
  return (Array.isArray(comments) ? comments : []).map((comment) => ({
    author: comment.author?.login ?? "unknown",
    body: comment.body ?? "",
    createdAt: comment.createdAt ?? "",
    url: comment.url,
  }));
}

function assignees(issue: RawIssue) {
  return (issue.assignees ?? [])
    .map((assignee) =>
      typeof assignee === "string" ? assignee : assignee.login ?? "",
    )
    .filter(Boolean);
}

function plainMarkdown(value: string) {
  return value
    .replace(/<!--[^]*?-->/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/^>\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseMarkdownSections(body: string): MapSection[] {
  const sections: MapSection[] = [];
  let heading = "Overview";
  let lines: string[] = [];
  const flush = () => {
    const sectionBody = lines.join("\n").trim();
    if (!sectionBody) return;
    sections.push({
      heading,
      body: sectionBody,
      items: bulletItems(sectionBody),
    });
  };
  for (const line of body.split("\n")) {
    const match = line.match(/^##\s+(.+?)\s*$/);
    if (match) {
      flush();
      heading = match[1] ?? "";
      lines = [];
    } else if (heading) {
      lines.push(line);
    }
  }
  flush();
  return sections;
}

function section(body: string, heading: string) {
  return (
    parseMarkdownSections(body).find(
      (candidate) => candidate.heading.toLowerCase() === heading.toLowerCase(),
    )?.body ?? ""
  );
}

export function findTrackerMigration(
  values: string[],
  kind: "map" | "ticket",
): TrackerReference | undefined {
  const text = values.join("\n");

  if (/jira is now the source of truth|moved to jira|canonical (?:execution )?tracker:\s*jira/i.test(text)) {
    const jiraPattern =
      kind === "ticket"
        ? /https:\/\/[^\s)]+\.atlassian\.net\/browse\/([A-Z]+-\d+)/gi
        : /https:\/\/[^\s)]+\.atlassian\.net\/(?:jira\/[^\s)]*\/boards\/\d+|browse\/([A-Z]+-\d+))/gi;
    const match = [...text.matchAll(jiraPattern)].at(-1);
    if (match?.[0]) {
      const url = match[0].replace(/[.,;:]+$/, "");
      return {
        provider: "jira",
        id: match[1] ?? (url.match(/boards\/(\d+)/)?.[1] ? `board:${url.match(/boards\/(\d+)/)![1]}` : url),
        url,
        canonical: true,
      };
    }
  }

  if (!/linear is now the source of truth|moved to linear/i.test(text)) return undefined;
  const pattern =
    kind === "map"
      ? /https:\/\/linear\.app\/[^\s)]+\/project\/[^\s)]+/gi
      : /https:\/\/linear\.app\/[^\s)]+\/issue\/([A-Z]+-\d+)(?:\/[^\s)]*)?/gi;
  const matches = [...text.matchAll(pattern)];
  const match = matches.at(-1);
  if (!match?.[0]) return undefined;
  const url = match[0].replace(/[.,;:]+$/, "");
  return {
    provider: "linear",
    id: kind === "ticket" ? match[1] ?? url.split("/").at(-1)! : url.split("/").at(-1)!,
    url,
    canonical: true,
  };
}

function githubReference(repo: string, issue: RawIssue): TrackerReference {
  return {
    provider: "github",
    id: `#${issue.number}`,
    url:
      issue.html_url ??
      issue.url ??
      `https://github.com/${repo}/issues/${issue.number}`,
    canonical: true,
  };
}

function firstParagraph(value: string) {
  const paragraph = value
    .split(/\n\s*\n/)
    .map(plainMarkdown)
    .find(Boolean);
  return paragraph ?? "No destination recorded.";
}

function bulletItems(value: string) {
  return value
    .split("\n")
    .map((line) => line.match(/^\s*[-*]\s+(.*)$/)?.[1] ?? "")
    .map(plainMarkdown)
    .filter(Boolean);
}

function ticketType(issue: RawIssue): TicketType {
  const issueLabels = labels(issue);
  const label = issueLabels.find((name) => name.startsWith("wayfinder:"));
  const type = label?.slice("wayfinder:".length);
  if (type === "research" || type === "prototype" || type === "grilling") {
    return type;
  }
  if (issueLabels.includes("research")) return "research";
  return "task";
}

export function isMapRoot(issue: RawIssue) {
  const issueLabels = labels(issue);
  return issueLabels.includes("wayfinder:map") || issueLabels.includes("epic");
}

function ticketMode(type: TicketType) {
  return type === "research" ? ("AFK" as const) : ("HITL" as const);
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

function parseWorktrees(value: string) {
  const result: LocalWorktree[] = [];
  let currentPath = "";
  for (const line of value.split("\n")) {
    if (line.startsWith("worktree ")) currentPath = line.slice(9);
    if (line.startsWith("branch ") && currentPath) {
      result.push({
        path: currentPath,
        branch: line.slice(7).replace(/^refs\/heads\//, ""),
      });
    }
  }
  return result;
}

function reviewState(pr: RawPullRequest): ReviewState {
  if (pr.state === "MERGED") return "merged";
  if (pr.isDraft) return "draft";
  if (pr.reviewDecision === "APPROVED") return "approved";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "changes-requested";
  if (pr.reviewDecision === "REVIEW_REQUIRED" || pr.reviewRequests.length > 0) {
    return "review-required";
  }
  return "open";
}

function checkState(pr: RawPullRequest) {
  if (pr.statusCheckRollup.some((check) => check.status !== "COMPLETED")) {
    return "pending" as const;
  }
  if (
    pr.statusCheckRollup.some((check) =>
      ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(
        check.conclusion ?? "",
      ),
    )
  ) {
    return "failing" as const;
  }
  return "passing" as const;
}

function matchPullRequest(issueNumber: number, pullRequests: RawPullRequest[]) {
  return pullRequests.find((pr) =>
    pr.closingIssuesReferences.some((issue) => issue.number === issueNumber),
  );
}

function mapDestination(body: string, epic: boolean) {
  const explicit = section(body, "Destination") || section(body, "Goal");
  if (explicit) return firstParagraph(explicit);
  const paragraphs = body
    .split(/\n\s*\n/)
    .map(plainMarkdown)
    .filter(Boolean);
  if (epic) {
    return (
      paragraphs.find(
        (paragraph) =>
          !paragraph.startsWith("Tracking issue.") &&
          !paragraph.startsWith("Work items are"),
      ) ?? paragraphs[0] ?? "No destination recorded."
    );
  }
  return paragraphs[0] ?? "No destination recorded.";
}

function inferOutcome(body: string) {
  const normalized = body.toLowerCase();
  if (
    normalized.includes("plan-only") ||
    normalized.includes("this map plans") ||
    normalized.includes("does not implement") ||
    normalized.includes("does not extract")
  ) {
    return "specification" as const;
  }
  if (normalized.includes("deploy") || normalized.includes("production")) {
    return "deployed" as const;
  }
  return "implemented" as const;
}

async function dependencies(
  repo: string,
  issue: RawIssue,
  cwd: string,
): Promise<DependencyRef[]> {
  try {
    const blockers = await json<RawIssue[]>(
      "gh",
      [
        "api",
        "--method",
        "GET",
        `repos/${repo}/issues/${issue.number}/dependencies/blocked_by`,
        "-f",
        "per_page=100",
      ],
      cwd,
    );
    return blockers.map((blocker) => ({
      id: `#${blocker.number}`,
      title: blocker.title,
      state: blocker.state.toLowerCase() === "closed" ? "closed" : "open",
    }));
  } catch {
    const fallback = issue.body?.match(/^Blocked by:\s*(.*)$/im)?.[1] ?? "";
    return [...fallback.matchAll(/#(\d+)/g)].map((match) => ({
      id: `#${match[1]}`,
      title: "Fallback body dependency",
      state: "open" as const,
    }));
  }
}

async function ticketFromIssue(
  issue: RawIssue,
  repo: string,
  pullRequests: RawPullRequest[],
  worktrees: LocalWorktree[],
): Promise<Ticket> {
  const type = ticketType(issue);
  const issueAssignees = assignees(issue);
  const issueComments = normalizeComments(issue.comments);
  const fallbackBlockers = [
    ...(issue.body?.match(/^Blocked by:\s*(.*)$/im)?.[1] ?? "").matchAll(/#(\d+)/g),
  ].map((match) => `#${match[1]}`);
  const openBlockerCount = issue.issue_dependencies_summary?.blocked_by ?? fallbackBlockers.length;
  const blockers = fallbackBlockers.length
    ? fallbackBlockers
    : Array.from(
        { length: openBlockerCount },
        (_, index) => `${openBlockerCount} open blocker${openBlockerCount === 1 ? "" : "s"}${index ? ` ${index + 1}` : ""}`,
      );
  const pr = matchPullRequest(issue.number, pullRequests);
  const worktree = pr
    ? worktrees.find((item) => item.branch === pr.headRefName)
    : undefined;
  const state = issue.state.toLowerCase();
  const issueBody = issue.body ?? "";
  const question = firstParagraph(
    section(issueBody, "Question") || section(issueBody, "Goal") || issueBody,
  );
  const githubSource = githubReference(repo, issue);
  const migratedSource = findTrackerMigration(
    [issue.body ?? "", ...issueComments.map((comment) => comment.body)],
    "ticket",
  );

  return {
    id: `#${issue.number}`,
    title: issue.title,
    question,
    body: issue.body ?? "",
    url: issue.html_url ?? issue.url,
    labels: labels(issue),
    assignees: issueAssignees,
    comments: issueComments,
    commentCount:
      typeof issue.comments === "number" ? issue.comments : issueComments.length,
    dependencies: fallbackBlockers.map((id) => ({
      id,
      title: "Body dependency",
      state: "open" as const,
    })),
    hydrated: Array.isArray(issue.comments),
    source: migratedSource ?? githubSource,
    mirror: migratedSource ? { ...githubSource, canonical: false } : undefined,
    type,
    mode: ticketMode(type),
    domains: [],
    capabilities: [],
    trackerState: migratedSource
      ? "migrated"
      : state === "closed"
        ? "resolved"
        : issueAssignees.length
          ? "claimed"
          : "open",
    assignee: issueAssignees[0] ? `@${issueAssignees[0]}` : undefined,
    blockedBy: blockers,
    workspace: worktree
      ? { branch: worktree.branch, path: worktree.path }
      : undefined,
    review: pr
      ? {
          number: pr.number,
          title: pr.title,
          url: pr.url,
          branch: pr.headRefName,
          state: reviewState(pr),
          checks: checkState(pr),
        }
      : undefined,
  };
}

function githubTracker(
  defaults: CockpitData,
  repo: string,
): TrackerProfile[] {
  const existing = defaults.trackers.find((tracker) => tracker.id === "github")!;
  const configured: TrackerProfile = {
    ...existing,
    repositoryLabel: repo,
    auth: "gh CLI authenticated · live read-only data",
  };
  return [configured, ...defaults.trackers.filter((tracker) => tracker.id !== "github")];
}

export async function resolveRepositoryRoot(cwd: string) {
  return (await run("git", ["rev-parse", "--show-toplevel"], cwd)).trim();
}

export async function claimGitHubTicket(cwd: string, ticketId: string) {
  const number = ticketId.replace(/^#/, "");
  if (!/^\d+$/.test(number)) throw new Error(`Invalid GitHub ticket id: ${ticketId}`);
  await run("gh", ["issue", "edit", number, "--add-assignee", "@me"], cwd);
}

export async function hydrateGitHubTicket(
  cwd: string,
  repo: string,
  ticket: Ticket,
): Promise<Partial<Ticket>> {
  const number = ticket.id.replace(/^#/, "");
  if (!/^\d+$/.test(number)) throw new Error(`Invalid GitHub ticket id: ${ticket.id}`);
  const issue: RawIssue = {
    number: Number(number),
    title: ticket.title,
    body: ticket.body,
    state: ticket.trackerState === "resolved" ? "closed" : "open",
  };
  const [issueDependencies, issueView] = await Promise.all([
    dependencies(repo, issue, cwd),
    json<{ comments: RawComment[] }>(
      "gh",
      ["issue", "view", number, "--json", "comments"],
      cwd,
    ),
  ]);
  const comments = normalizeComments(issueView.comments);
  const migratedSource = findTrackerMigration(
    [ticket.body ?? "", ...comments.map((comment) => comment.body)],
    "ticket",
  );
  const githubSource = ticket.mirror ?? ticket.source;
  return {
    comments,
    commentCount: comments.length,
    dependencies: issueDependencies,
    blockedBy: issueDependencies
      .filter((dependency) => dependency.state === "open")
      .map((dependency) => dependency.id),
    hydrated: true,
    hydrating: false,
    ...(migratedSource
      ? {
          source: migratedSource,
          mirror: githubSource
            ? { ...githubSource, canonical: false }
            : undefined,
          trackerState: "migrated" as const,
        }
      : {}),
  };
}

export async function isGitHubTrackerConfigured(cwd: string) {
  const root = await resolveRepositoryRoot(cwd);
  try {
    const trackerInstructions = await readFile(
      path.join(root, "docs/agents/issue-tracker.md"),
      "utf8",
    );
    return /Issue tracker:\s*GitHub/i.test(trackerInstructions);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function loadGitHubWayfinderData(
  cwd: string,
  defaults: CockpitData,
): Promise<CockpitData> {
  const root = await resolveRepositoryRoot(cwd);
  if (!(await isGitHubTrackerConfigured(root))) {
    throw new Error(
      "Wayfinder is not configured for this repository. Add docs/agents/issue-tracker.md and declare `Issue tracker: GitHub`, or add a local map.md with an adjacent issues/ directory.",
    );
  }

  const { nameWithOwner: repo } = await json<{ nameWithOwner: string }>(
    "gh",
    ["repo", "view", "--json", "nameWithOwner"],
    root,
  );
  const listMapRoots = (label: string) =>
    json<RawIssue[]>(
      "gh",
      [
        "issue",
        "list",
        "--state",
        "all",
        "--label",
        label,
        "--limit",
        "1000",
        "--json",
        "number,title,body,state,labels,assignees,comments,updatedAt,url",
      ],
      root,
    );
  const [epicIssues, wayfinderIssues, pullRequests, worktreeOutput] = await Promise.all([
    listMapRoots("epic"),
    listMapRoots("wayfinder:map"),
    json<RawPullRequest[]>(
      "gh",
      [
        "pr",
        "list",
        "--state",
        "all",
        "--limit",
        "200",
        "--json",
        "number,title,url,state,isDraft,reviewDecision,reviewRequests,statusCheckRollup,headRefName,closingIssuesReferences",
      ],
      root,
    ),
    run("git", ["worktree", "list", "--porcelain"], root),
  ]);
  const worktrees = parseWorktrees(worktreeOutput);
  const allIssues = [...epicIssues, ...wayfinderIssues].filter(
    (issue, index, issues) =>
      issues.findIndex((candidate) => candidate.number === issue.number) === index,
  );
  const mapIssues = allIssues
    .filter(isMapRoot)
    .sort((a, b) => {
      const stateDifference = Number(a.state.toLowerCase() === "closed") - Number(b.state.toLowerCase() === "closed");
      if (stateDifference !== 0) return stateDifference;
      return Date.parse(b.updatedAt ?? b.updated_at ?? "") - Date.parse(a.updatedAt ?? a.updated_at ?? "");
    });

  const maps = await mapConcurrent(mapIssues, 4, async (mapIssue): Promise<WayfinderMap> => {
    const children = await json<RawIssue[]>(
      "gh",
      [
        "api",
        "--method",
        "GET",
        `repos/${repo}/issues/${mapIssue.number}/sub_issues`,
        "-f",
        "per_page=100",
      ],
      root,
    );
    const tickets = await mapConcurrent(children, 4, (issue) =>
      ticketFromIssue(issue, repo, pullRequests, worktrees),
    );
    const body = mapIssue.body ?? "";
    const epic = labels(mapIssue).includes("epic");
    const mapSections = parseMarkdownSections(body);
    const githubSource = githubReference(repo, mapIssue);
    const mapComments = normalizeComments(mapIssue.comments);
    const migratedSource = findTrackerMigration(
      [body, ...mapComments.map((comment) => comment.body)],
      "map",
    );
    if (migratedSource) {
      for (const ticket of tickets) {
        if (!ticket.mirror && ticket.source) {
          ticket.mirror = { ...ticket.source, canonical: false };
        }
        ticket.source = migratedSource;
        ticket.trackerState = "migrated";
      }
    }
    const updatedAt = mapIssue.updatedAt ?? mapIssue.updated_at;
    return {
      id: `${repo}#${mapIssue.number}`,
      kind: epic ? "epic" : "wayfinder",
      repository: repo,
      title: mapIssue.title,
      destination: mapDestination(body, epic),
      body,
      url: mapIssue.url ?? mapIssue.html_url,
      labels: labels(mapIssue),
      comments: mapComments,
      source: migratedSource ?? githubSource,
      mirror: migratedSource ? { ...githubSource, canonical: false } : undefined,
      sections: mapSections,
      notes: bulletItems(section(body, "Notes")),
      decisions: bulletItems(section(body, "Decisions so far")),
      fog: bulletItems(section(body, "Not yet specified")),
      outOfScope: bulletItems(section(body, "Out of scope")),
      updated: relativeTime(updatedAt),
      state: mapIssue.state.toLowerCase() === "closed" ? "closed" : "open",
      autoRun: false,
      outcome: inferOutcome(body),
      tickets,
      activity: [...children]
        .sort((a, b) =>
          Date.parse(b.updated_at ?? b.updatedAt ?? "") -
          Date.parse(a.updated_at ?? a.updatedAt ?? ""),
        )
        .slice(0, 5)
        .map(
          (issue) =>
            `${relativeTime(issue.updated_at ?? issue.updatedAt)}  #${issue.number} ${issue.state.toLowerCase()}`,
        ),
    };
  });

  if (!maps.length) {
    throw new Error(`No epic or Wayfinder map roots were found in ${repo}.`);
  }

  return {
    ...defaults,
    maps,
    discoveries: [],
    trackers: githubTracker(defaults, repo),
  };
}
