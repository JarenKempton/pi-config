import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AgentTarget,
  RoutingRule,
} from "./types.ts";

export interface AutomationConfig {
  autoDispatchResearch: boolean;
  autoDispatchTasks: boolean;
  discoveryPolicy: "ask" | "safe" | "automatic";
  autoResolve: boolean;
  maxDiscoveryDepth: number;
  maxTicketsPerRun: number;
  maxConcurrentPerMap: number;
}

export interface WorkspaceSettings {
  trackerId: string;
  jiraBoardId: string;
  deliveryProfileId: string;
  agentDefaults: {
    HITL: AgentTarget;
    AFK: AgentTarget;
  };
  routes: RoutingRule[];
  automation: AutomationConfig;
}

interface SettingsDocument {
  version: 1;
  workspaces: Record<string, WorkspaceSettings>;
}

const SETTINGS_DIRECTORY = path.join(
  process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"),
  "wayfinder",
);
const SETTINGS_PATH = path.join(SETTINGS_DIRECTORY, "settings.json");

export function defaultWorkspaceSettings(routes: RoutingRule[]): WorkspaceSettings {
  return {
    trackerId: "github",
    jiraBoardId: "6",
    deliveryProfileId: "",
    agentDefaults: {
      HITL: {
        runtime: "Pi",
        model: "inherit",
        effort: "high",
        profile: "worker",
      },
      AFK: {
        runtime: "Pi",
        model: "inherit",
        effort: "medium",
        profile: "researcher",
      },
    },
    routes: routes.map((route) => ({ ...route })),
    automation: {
      autoDispatchResearch: false,
      autoDispatchTasks: false,
      discoveryPolicy: "ask",
      autoResolve: false,
      maxDiscoveryDepth: 2,
      maxTicketsPerRun: 3,
      maxConcurrentPerMap: 2,
    },
  };
}

async function readDocument(): Promise<SettingsDocument> {
  try {
    const parsed = JSON.parse(await readFile(SETTINGS_PATH, "utf8")) as Partial<SettingsDocument>;
    if (parsed.version !== 1 || !parsed.workspaces) {
      throw new Error("Unsupported Wayfinder settings schema");
    }
    return parsed as SettingsDocument;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, workspaces: {} };
    }
    throw error;
  }
}

async function writeDocument(document: SettingsDocument) {
  await mkdir(SETTINGS_DIRECTORY, { recursive: true, mode: 0o700 });
  const temporaryPath = `${SETTINGS_PATH}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, SETTINGS_PATH);
}

export async function workspaceKey(cwd: string) {
  return realpath(cwd);
}

async function repositoryTracker(cwd: string) {
  try {
    const instructions = await readFile(
      path.join(cwd, "docs", "agents", "issue-tracker.md"),
      "utf8",
    );
    const declared = instructions.match(/^Issue tracker:\s*(Jira|GitHub|Markdown)\s*$/im)?.[1];
    return declared?.toLowerCase();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function loadWorkspaceSettings(
  cwd: string,
  routes: RoutingRule[],
): Promise<{ key: string; settings: WorkspaceSettings; persisted: boolean }> {
  const key = await workspaceKey(cwd);
  const document = await readDocument();
  const stored = document.workspaces[key];
  const defaults = defaultWorkspaceSettings(routes);
  const declaredTracker = await repositoryTracker(key);
  return {
    key,
    settings: stored
      ? { ...stored, jiraBoardId: stored.jiraBoardId ?? "6" }
      : {
          ...defaults,
          trackerId: declaredTracker ?? defaults.trackerId,
        },
    persisted: Boolean(stored),
  };
}

export async function saveWorkspaceSettings(
  key: string,
  settings: WorkspaceSettings,
) {
  const document = await readDocument();
  document.workspaces[key] = settings;
  await writeDocument(document);
}

export function settingsPath() {
  return SETTINGS_PATH;
}

export function wayfinderDirectory() {
  return SETTINGS_DIRECTORY;
}
