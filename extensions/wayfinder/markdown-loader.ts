import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseMarkdownSections, resolveRepositoryRoot } from "./github-loader.ts";
import type {
  CockpitData,
  DependencyRef,
  MapOutcome,
  Ticket,
  TicketType,
  TrackerProfile,
  WayfinderMap,
} from "./types.ts";

const SKIPPED_DIRECTORIES = new Set([
  ".claude",
  ".git",
  ".next",
  ".nx",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
]);
const MAX_DISCOVERY_DEPTH = 8;

function plainMarkdown(value: string) {
  return value
    .replace(/<!--[^]*?-->/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/^>\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function heading(document: string) {
  return document.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim() ?? "Untitled Wayfinder map";
}

function field(document: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return document.match(new RegExp(`^${escaped}:\\s*(.+?)\\s*$`, "im"))?.[1]?.trim();
}

function section(document: string, name: string) {
  return (
    parseMarkdownSections(document).find(
      (candidate) => candidate.heading.toLowerCase() === name.toLowerCase(),
    )?.body ?? ""
  );
}

function bulletItems(value: string) {
  return value
    .split("\n")
    .map((line) => line.match(/^\s*[-*]\s+(.*)$/)?.[1] ?? "")
    .map(plainMarkdown)
    .filter(Boolean);
}

function firstParagraph(value: string) {
  return (
    value
      .split(/\n\s*\n/)
      .map(plainMarkdown)
      .find(Boolean) ?? "No question recorded."
  );
}

function ticketType(value: string | undefined): TicketType {
  const normalized = value?.toLowerCase();
  if (
    normalized === "research" ||
    normalized === "prototype" ||
    normalized === "grilling" ||
    normalized === "task"
  ) {
    return normalized;
  }
  return "task";
}

function trackerState(value: string | undefined): Ticket["trackerState"] {
  const normalized = value?.toLowerCase().replace(/[ _]/g, "-") ?? "open";
  if (["resolved", "closed", "complete", "completed", "done"].includes(normalized)) {
    return "resolved";
  }
  if (["claimed", "in-progress", "running", "active"].includes(normalized)) {
    return "claimed";
  }
  return "open";
}

function blockerIds(value: string | undefined) {
  if (!value || /^(none|n\/a|—|-)$/i.test(value.trim())) return [];
  return value
    .split(/[,;]/)
    .map((item) => item.trim().replace(/^#/, ""))
    .map((item) => item.match(/[A-Za-z]*-?\d+/)?.[0] ?? item)
    .filter(Boolean);
}

function inferOutcome(body: string): MapOutcome {
  const normalized = body.toLowerCase();
  if (
    normalized.includes("plan-only") ||
    normalized.includes("this map plans") ||
    normalized.includes("does not implement")
  ) {
    return "specification";
  }
  if (normalized.includes("deploy") || normalized.includes("production rollout")) {
    return "deployed";
  }
  return "implemented";
}

function relativeTime(timestamp: number) {
  const delta = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

async function discoverNamedFiles(
  directory: string,
  predicate: (name: string) => boolean,
  depth = 0,
): Promise<string[]> {
  if (depth > MAX_DISCOVERY_DEPTH) return [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      files.push(
        ...(await discoverNamedFiles(path.join(directory, entry.name), predicate, depth + 1)),
      );
    } else if (entry.isFile() && predicate(entry.name)) {
      files.push(path.join(directory, entry.name));
    }
  }
  return files;
}

export async function discoverMarkdownMapFiles(repositoryRoot: string) {
  return (
    await discoverNamedFiles(
      repositoryRoot,
      (name) => name.toLowerCase() === "map.md" || name.toLowerCase() === "wayfinder.md",
    )
  ).sort();
}

async function issueFiles(mapPath: string) {
  const directory = path.join(path.dirname(mapPath), "issues");
  return (
    await discoverNamedFiles(directory, (name) => /\.md$/i.test(name))
  ).sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

interface ParsedTicket {
  ticket: Ticket;
  rawBlockers: string[];
  modifiedAt: number;
}

async function parseTicket(repositoryRoot: string, issuePath: string): Promise<ParsedTicket> {
  const [body, metadata] = await Promise.all([readFile(issuePath, "utf8"), stat(issuePath)]);
  const relativePath = path.relative(repositoryRoot, issuePath);
  const fileId = path.basename(issuePath).match(/^([A-Za-z]*-?\d+)/)?.[1] ??
    path.basename(issuePath, path.extname(issuePath));
  const type = ticketType(field(body, "Type"));
  const state = trackerState(field(body, "Status"));
  const questionBody = section(body, "Question") || body;
  return {
    ticket: {
      id: fileId,
      title: heading(body),
      question: firstParagraph(questionBody),
      body,
      url: relativePath,
      source: {
        provider: "markdown",
        id: relativePath,
        url: pathToFileURL(issuePath).href,
        canonical: true,
      },
      type,
      mode: /^afk$/i.test(field(body, "Mode") ?? "") || type === "research" ? "AFK" : "HITL",
      domains: [],
      capabilities: ["code"],
      trackerState: state,
      blockedBy: [],
      hydrated: true,
      comments: [],
      commentCount: 0,
    },
    rawBlockers: blockerIds(field(body, "Blocked by")),
    modifiedAt: metadata.mtimeMs,
  };
}

async function parseMap(repositoryRoot: string, mapPath: string): Promise<WayfinderMap> {
  const [body, mapMetadata, parsedTickets] = await Promise.all([
    readFile(mapPath, "utf8"),
    stat(mapPath),
    issueFiles(mapPath).then((files) => Promise.all(files.map((file) => parseTicket(repositoryRoot, file)))),
  ]);
  const tickets = parsedTickets.map((entry) => entry.ticket);
  const byId = new Map(tickets.map((ticket) => [ticket.id.replace(/^#/, ""), ticket]));
  parsedTickets.forEach((entry) => {
    const dependencies: DependencyRef[] = entry.rawBlockers.map((id) => {
      const blocker = byId.get(id.replace(/^#/, ""));
      return {
        id,
        title: blocker?.title ?? "Markdown dependency",
        state: blocker?.trackerState === "resolved" ? "closed" : "open",
      };
    });
    entry.ticket.dependencies = dependencies;
    entry.ticket.blockedBy = dependencies
      .filter((dependency) => dependency.state === "open")
      .map((dependency) => dependency.id);
  });

  const mapDirectory = path.dirname(mapPath);
  const relativeMapPath = path.relative(repositoryRoot, mapPath);
  const sections = parseMarkdownSections(body);
  const destination = section(body, "Destination") || section(body, "Goal") || body;
  const latestModifiedAt = Math.max(
    mapMetadata.mtimeMs,
    ...parsedTickets.map((ticket) => ticket.modifiedAt),
  );
  const status = field(body, "Status")?.toLowerCase();
  return {
    id: `markdown:${relativeMapPath}`,
    kind: "wayfinder",
    repository: path.basename(repositoryRoot),
    title: heading(body),
    destination: firstParagraph(destination),
    body,
    url: relativeMapPath,
    source: {
      provider: "markdown",
      id: relativeMapPath,
      url: pathToFileURL(mapPath).href,
      canonical: true,
    },
    sections,
    notes: bulletItems(section(body, "Notes")),
    decisions: bulletItems(section(body, "Decisions so far")),
    fog: bulletItems(section(body, "Not yet specified")),
    outOfScope: bulletItems(section(body, "Out of scope")),
    updated: relativeTime(latestModifiedAt),
    state: status && ["resolved", "closed", "done"].includes(status) ? "closed" : "open",
    autoRun: false,
    outcome: inferOutcome(body),
    tickets,
    activity: parsedTickets
      .slice()
      .sort((left, right) => right.modifiedAt - left.modifiedAt)
      .slice(0, 5)
      .map((entry) => `${relativeTime(entry.modifiedAt)}  ${entry.ticket.id} ${entry.ticket.trackerState}`),
  };
}

function markdownTrackers(defaults: CockpitData, repositoryRoot: string, maps: WayfinderMap[]): TrackerProfile[] {
  const existing = defaults.trackers.find((tracker) => tracker.id === "markdown")!;
  const directories = maps.map((map) => path.dirname(map.url ?? "")).filter(Boolean);
  const configured: TrackerProfile = {
    ...existing,
    repositoryLabel: directories.join(", ") || path.basename(repositoryRoot),
    auth: "local repository files · no authentication",
  };
  return [configured, ...defaults.trackers.filter((tracker) => tracker.id !== "markdown")];
}

export async function loadMarkdownWayfinderData(
  cwd: string,
  defaults: CockpitData,
): Promise<CockpitData> {
  const repositoryRoot = await resolveRepositoryRoot(cwd);
  const mapFiles = await discoverMarkdownMapFiles(repositoryRoot);
  if (!mapFiles.length) {
    throw new Error(
      "No local Wayfinder map was found. Add map.md (or wayfinder.md) with an adjacent issues/ directory.",
    );
  }
  const maps = await Promise.all(mapFiles.map((mapPath) => parseMap(repositoryRoot, mapPath)));
  return {
    ...defaults,
    maps,
    discoveries: [],
    trackers: markdownTrackers(defaults, repositoryRoot, maps),
  };
}
