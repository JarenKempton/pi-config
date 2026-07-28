import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadWorkspaceSettings } from "./config.ts";
import { findTrackerMigration } from "./github-loader.ts";
import { mapFromJira, type JiraWorkItem } from "./jira-loader.ts";
import { presentationState } from "./state.ts";

function issue(
  key: string,
  status: string,
  options: {
    parent?: string;
    labels?: string[];
    assignee?: string;
    subtask?: boolean;
    links?: JiraWorkItem["fields"]["issuelinks"];
  } = {},
): JiraWorkItem {
  return {
    key,
    self: `https://jira.internal/rest/api/3/issue/${key}`,
    fields: {
      summary: `${key} summary`,
      description: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: `${key} outcome` }] }],
      },
      status: {
        name: status,
        statusCategory: {
          key: status === "Done" ? "done" : status === "To Do" ? "new" : "indeterminate",
          name: status === "Done" ? "Done" : status === "To Do" ? "To Do" : "In Progress",
        },
      },
      assignee: options.assignee ? { displayName: options.assignee } : undefined,
      issuetype: { name: options.subtask ? "Subtask" : "Story", subtask: options.subtask },
      labels: options.labels ?? [],
      parent: options.parent ? { key: options.parent } : undefined,
      issuelinks: options.links ?? [],
      updated: "2026-07-27T12:00:00.000-0700",
      comment: { comments: [], total: 0 },
    },
  };
}

test("Jira maps include parent tickets and subtasks with native statuses", () => {
  const root = issue("JWB-1", "In Progress");
  root.fields!.issuetype = { name: "Epic" };
  const parent = issue("JWB-5", "In Progress", { parent: "JWB-1", assignee: "Jaren" });
  const todo = issue("JWB-109", "To Do", {
    parent: "JWB-5",
    assignee: "Jaren",
    labels: ["wayfinder:research"],
    subtask: true,
  });
  const blocker = issue("JWB-108", "Blocked", {
    parent: "JWB-5",
    assignee: "Jaren",
    labels: ["wayfinder:research"],
    subtask: true,
    links: [{
      type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
      inwardIssue: issue("JWB-999", "To Do"),
    }],
  });
  const map = mapFromJira(
    root,
    [
      { issue: parent, depth: 1 },
      { issue: todo, depth: 2 },
      { issue: blocker, depth: 2 },
    ],
    "https://responsibid.atlassian.net",
  );

  assert.equal(map.tickets.length, 3);
  const todoTicket = map.tickets.find((ticket) => ticket.id === "JWB-109")!;
  assert.equal(todoTicket.parentId, "JWB-5");
  assert.equal(todoTicket.hierarchyLevel, 2);
  assert.equal(todoTicket.type, "research");
  assert.equal(todoTicket.trackerStatus, "To Do");
  assert.equal(todoTicket.trackerState, "open", "assignment must not turn Jira To Do into active");
  assert.equal(presentationState(todoTicket), "frontier");
  assert.equal(todoTicket.url, "https://responsibid.atlassian.net/browse/JWB-109");

  const parentTicket = map.tickets.find((ticket) => ticket.id === "JWB-5")!;
  assert.equal(presentationState(parentTicket), "in-flight");

  const blockedTicket = map.tickets.find((ticket) => ticket.id === "JWB-108")!;
  assert.equal(presentationState(blockedTicket), "blocked");
  assert.deepEqual(blockedTicket.blockedBy, ["JWB-999"]);
});

test("a repository Jira declaration becomes the default tracker", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wayfinder-jira-"));
  await mkdir(path.join(root, "docs", "agents"), { recursive: true });
  await writeFile(
    path.join(root, "docs", "agents", "issue-tracker.md"),
    "Issue tracker: Jira\n",
  );
  const loaded = await loadWorkspaceSettings(root, []);
  assert.equal(loaded.persisted, false);
  assert.equal(loaded.settings.trackerId, "jira");
});

test("GitHub migration markers recognize Jira tickets and boards", () => {
  assert.deepEqual(
    findTrackerMigration(
      ["Jira is now the source of truth: https://responsibid.atlassian.net/browse/JWB-108"],
      "ticket",
    ),
    {
      provider: "jira",
      id: "JWB-108",
      url: "https://responsibid.atlassian.net/browse/JWB-108",
      canonical: true,
    },
  );
  assert.deepEqual(
    findTrackerMigration(
      ["Canonical tracker: Jira https://responsibid.atlassian.net/jira/software/projects/JWB/boards/6"],
      "map",
    ),
    {
      provider: "jira",
      id: "board:6",
      url: "https://responsibid.atlassian.net/jira/software/projects/JWB/boards/6",
      canonical: true,
    },
  );
});
