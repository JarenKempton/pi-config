import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { buildActivityItems } from "../extensions/wayfinder/activity.ts";
import { defaultData } from "../extensions/wayfinder/defaults.ts";
import {
  findTrackerMigration,
  isMapRoot,
  parseMarkdownSections,
} from "../extensions/wayfinder/github-loader.ts";
import { renderCockpit } from "../extensions/wayfinder/render.ts";
import {
  initialState,
  presentationState,
  reduceCockpit,
} from "../extensions/wayfinder/state.ts";
import wayfinderExtension from "../extensions/wayfinder/index.ts";
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
