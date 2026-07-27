import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { buildActivityItems } from "../extensions/wayfinder/activity.ts";
import { defaultData } from "../extensions/wayfinder/defaults.ts";
import {
  findTrackerMigration,
  isMapRoot,
  parseMarkdownSections,
} from "../extensions/wayfinder/github-loader.ts";
import {
  loadJiraWayfinderData,
  mapFromJira,
} from "../extensions/wayfinder/jira-loader.ts";
import {
  discoverMarkdownMapFiles,
  loadMarkdownWayfinderData,
} from "../extensions/wayfinder/markdown-loader.ts";
import { renderCockpit } from "../extensions/wayfinder/render.ts";
import {
  initialState,
  presentationState,
  reduceCockpit,
} from "../extensions/wayfinder/state.ts";
import wayfinderExtension, {
  filterCachedMaps,
} from "../extensions/wayfinder/index.ts";
import type { CockpitData } from "../extensions/wayfinder/types.ts";

const theme = {
  fg: (_name: string, value: string) => value,
  bg: (_name: string, value: string) => value,
  bold: (value: string) => value,
} as Theme;

test("Wayfinder has one canonical command and direct cockpit shortcuts", () => {
  const commands: string[] = [];
  const shortcuts: string[] = [];
  wayfinderExtension({
    on: () => {},
    registerCommand: (name: string) => commands.push(name),
    registerShortcut: (name: string) => shortcuts.push(name),
  } as never);
  assert.deepEqual(commands, ["wayfinder"]);
  assert.deepEqual(shortcuts, ["alt+w", "alt+a"]);
});

test("map parsing retains custom sections instead of hard-coding the Wayfinder template", () => {
  const sections = parseMarkdownSections(`## Destination\nShip it.\n\n## In-scope molecule set\n- Dialog\n- Drawer\n\n## Recorded external blockers\n- Switch`);
  assert.deepEqual(
    sections.map((section) => [section.heading, section.items]),
    [
      ["Destination", []],
      ["In-scope molecule set", ["Dialog", "Drawer"]],
      ["Recorded external blockers", ["Switch"]],
    ],
  );
});

test("local Markdown maps load their adjacent issue ledger without tracker configuration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wayfinder-markdown-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    const effort = path.join(root, ".scratch", "effort");
    await mkdir(path.join(effort, "issues"), { recursive: true });
    await writeFile(
      path.join(effort, "map.md"),
      "# Wayfinder Map — Local effort\n\n## Destination\n\nMake the local map visible.\n\n## Notes\n\n- Keep Markdown canonical.\n",
    );
    await writeFile(
      path.join(effort, "issues", "01-research.md"),
      "# Research the seam\n\nType: research\nStatus: resolved\nBlocked by: none\n\n## Question\n\nWhere is the seam?\n",
    );
    await writeFile(
      path.join(effort, "issues", "02-decide.md"),
      "# Decide the adapter\n\nType: grilling\nStatus: open\nBlocked by: 01\n\n## Question\n\nWhich adapter should win?\n",
    );

    const data = await loadMarkdownWayfinderData(root, structuredClone(defaultData));
    assert.equal(data.maps.length, 1);
    assert.equal(data.maps[0]?.source?.provider, "markdown");
    assert.equal(data.maps[0]?.tickets.length, 2);
    assert.equal(data.maps[0]?.tickets[1]?.blockedBy.length, 0);
    assert.equal(data.maps[0]?.tickets[1]?.dependencies?.[0]?.state, "closed");
    assert.equal(data.trackers[0]?.id, "markdown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Markdown discovery ignores nested worktree copies of the canonical map", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wayfinder-worktrees-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    const canonical = path.join(root, "wayfinder", "delivery");
    const copy = path.join(
      root,
      ".claude",
      "worktrees",
      "old-agent",
      "wayfinder",
      "delivery",
    );
    await mkdir(canonical, { recursive: true });
    await mkdir(copy, { recursive: true });
    await writeFile(path.join(canonical, "map.md"), "# Canonical map\n");
    await writeFile(path.join(copy, "map.md"), "# Canonical map\n");

    const maps = await discoverMarkdownMapFiles(root);
    assert.deepEqual(maps, [path.join(canonical, "map.md")]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stale cache filtering removes previously indexed worktree maps", () => {
  const canonical = structuredClone(defaultData.maps[0]!);
  canonical.source = {
    provider: "markdown",
    id: "wayfinder/delivery/map.md",
    url: "file:///repo/wayfinder/delivery/map.md",
    canonical: true,
  };
  const worktree = structuredClone(canonical);
  worktree.source!.id = ".claude/worktrees/old/wayfinder/delivery/map.md";

  assert.deepEqual(filterCachedMaps([worktree, canonical]), [canonical]);
});

test("Jira epics become one map with child work items and blocker state", () => {
  const map = mapFromJira(
    {
      key: "TEAM-10",
      self: "https://example.atlassian.net/rest/api/3/issue/10010",
      fields: {
        summary: "Ship the migration",
        description: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Move safely." }] }],
        },
        status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
        issuetype: { name: "Epic" },
        updated: "2026-07-27T12:00:00.000Z",
      },
    },
    [
      {
        key: "TEAM-11",
        self: "https://example.atlassian.net/rest/api/3/issue/10011",
        fields: {
          summary: "Build the adapter",
          description: "Use Jira as the canonical tracker.",
          status: { name: "To Do", statusCategory: { key: "new" } },
          assignee: { displayName: "Jaren" },
          issuetype: { name: "Story" },
          labels: ["research"],
          updated: "2026-07-27T13:00:00.000Z",
          issuelinks: [
            {
              type: { name: "Blocks" },
              inwardIssue: {
                key: "TEAM-9",
                fields: {
                  summary: "Choose the migration path",
                  status: { statusCategory: { key: "done" } },
                },
              },
            },
          ],
        },
      },
    ],
  );

  assert.equal(map.id, "jira:TEAM-10");
  assert.equal(map.source?.provider, "jira");
  assert.equal(map.url, "https://example.atlassian.net/browse/TEAM-10");
  assert.equal(map.tickets.length, 1);
  assert.equal(map.tickets[0]?.id, "TEAM-11");
  assert.equal(map.tickets[0]?.trackerState, "claimed");
  assert.equal(map.tickets[0]?.mode, "AFK");
  assert.deepEqual(map.tickets[0]?.dependencies, [
    { id: "TEAM-9", title: "Choose the migration path", state: "closed" },
  ]);
  assert.deepEqual(map.tickets[0]?.blockedBy, []);
});

test("Jira loader checks auth and loads epic children through ACLI JSON", async () => {
  const calls: string[][] = [];
  const data = await loadJiraWayfinderData("/repo", structuredClone(defaultData), async (args) => {
    calls.push(args);
    if (args.includes("status")) return "Authenticated";
    const jql = args[args.indexOf("--jql") + 1];
    if (jql?.startsWith("parent =")) {
      return JSON.stringify({ issues: [{ key: "TEAM-11", fields: { summary: "Child" } }] });
    }
    return JSON.stringify({ issues: [{ key: "TEAM-10", fields: { summary: "Epic" } }] });
  });

  assert.equal(data.maps.length, 1);
  assert.equal(data.maps[0]?.tickets[0]?.id, "TEAM-11");
  assert.deepEqual(calls[0], ["jira", "auth", "status"]);
  assert.ok(calls[1]?.includes("--json"));
  const fields = calls[1]?.[calls[1].indexOf("--fields") + 1] ?? "";
  assert.equal(fields, "key,summary,description,status,assignee,issuetype,labels");
  assert.ok(!fields.includes("updated"));
  assert.ok(!fields.includes("parent"));
  assert.ok(!fields.includes("issuelinks"));
  assert.ok(calls[2]?.includes("parent = TEAM-10 ORDER BY rank"));
});

test("repository epics and Wayfinder maps are both map roots", () => {
  const issue = (names: string[]) => ({
    number: 1,
    title: "root",
    state: "open",
    labels: names.map((name) => ({ name })),
  });
  assert.equal(isMapRoot(issue(["epic"])), true);
  assert.equal(isMapRoot(issue(["wayfinder:map"])), true);
  assert.equal(isMapRoot(issue(["enhancement"])), false);
});

test("tracker migration pointers identify Linear as canonical", () => {
  const source = findTrackerMigration(
    [
      "Moved to Linear as a project: https://linear.app/salesai-jaren/project/tighten-the-lint-policy-f13328d7258a\nLinear is now the source of truth.",
    ],
    "map",
  );
  assert.deepEqual(source, {
    provider: "linear",
    id: "tighten-the-lint-policy-f13328d7258a",
    url: "https://linear.app/salesai-jaren/project/tighten-the-lint-policy-f13328d7258a",
    canonical: true,
  });
});

test("an unconfigured repository renders an actionable empty state instead of crashing", () => {
  const data: CockpitData = {
    ...structuredClone(defaultData),
    maps: [],
    trackerRefresh: {
      state: "error",
      error: "Wayfinder is not configured for this repository.",
    },
  };
  const output = renderCockpit(initialState(data), data, theme, 120, 18).join("\n");
  assert.match(output, /NO MAPS AVAILABLE/);
  assert.match(output, /Wayfinder is not configured for this repository/);
});

test("the cockpit reserves a stable height while selection details change", () => {
  const data = structuredClone(defaultData);
  data.maps[1]!.source = {
    provider: "linear",
    id: "moved-map",
    url: "https://linear.app/example/project/moved-map",
    canonical: true,
  };
  data.maps[1]!.mirror = {
    provider: "github",
    id: "#2",
    url: "https://github.com/example/repo/issues/2",
    canonical: false,
  };
  const first = initialState(data);
  const second = reduceCockpit(first, { type: "down" }, data);
  assert.equal(
    renderCockpit(first, data, theme, 120, 18).length,
    renderCockpit(second, data, theme, 120, 18).length,
  );
});

test("activity keeps tracker frontiers independent from agent execution", () => {
  const data = structuredClone(defaultData) as CockpitData;
  const entries = data.maps.flatMap((map) =>
    map.tickets.map((ticket) => ({ map, ticket })),
  );
  assert.ok(entries.length >= 7);
  entries.forEach(({ ticket }) => {
    ticket.trackerState = "open";
    ticket.blockedBy = [];
    ticket.attention = undefined;
  });
  entries[3]!.ticket.trackerState = "resolved";
  entries[4]!.ticket.attention = "needs-input";
  entries[5]!.ticket.blockedBy = ["#blocker"];
  const run = (index: number, status: "running" | "done" | "error") => ({
    id: `run-${index}`,
    mapId: entries[index]!.map.id,
    ticketId: entries[index]!.ticket.id,
    title: entries[index]!.ticket.title,
    backend: "Pi" as const,
    profile: "worker" as const,
    cwd: "/repo",
    status,
    createdAt: index,
    updatedAt: index,
  });
  data.runs = [run(0, "running"), run(1, "done"), run(2, "error")];

  const categories = new Map(
    buildActivityItems(data).map((item) => [item.ticket?.id, item.category]),
  );
  assert.equal(categories.get(entries[0]!.ticket.id), "moving");
  assert.equal(categories.get(entries[1]!.ticket.id), "result-ready");
  assert.equal(categories.get(entries[2]!.ticket.id), "failed");
  assert.equal(categories.get(entries[3]!.ticket.id), "resolved");
  assert.equal(categories.get(entries[4]!.ticket.id), "needs-input");
  assert.equal(categories.get(entries[5]!.ticket.id), "waiting");
  assert.equal(categories.get(entries[6]!.ticket.id), "ready");
});

test("the primary map board exposes map sections and stale-mirror state", () => {
  const map = structuredClone(defaultData.maps[0]!);
  map.source = {
    provider: "linear",
    id: "project-map",
    url: "https://linear.app/example/project/project-map",
    canonical: true,
  };
  map.mirror = {
    provider: "github",
    id: "#17",
    url: "https://github.com/example/repo/issues/17",
    canonical: false,
  };
  map.sections = parseMarkdownSections(map.body ?? "");
  map.tickets[0]!.trackerState = "migrated";
  const data: CockpitData = { ...defaultData, maps: [map] };
  let state = initialState(data);
  state = reduceCockpit(state, { type: "enter" }, data);
  const output = renderCockpit(state, data, theme, 120).join("\n");
  assert.match(output, /MOVED · canonical linear map is not loaded/);
  assert.match(output, /NOTES \d+/);
  assert.match(output, /DECISIONS \d+/);
  assert.match(output, /FOG \d+/);
  assert.match(output, /OUT OF SCOPE \d+/);
  assert.equal(presentationState(map.tickets[0]!), "attention");
});
