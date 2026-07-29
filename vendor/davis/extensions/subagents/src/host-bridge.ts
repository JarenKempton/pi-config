import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  BackendName,
  ReasoningEffort,
  SubagentProfile,
  SubagentSnapshot,
} from "./domain.ts";

export interface HostSpawnRequest {
  backend: BackendName;
  title: string;
  prompt: string;
  cwd: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  profile: Exclude<SubagentProfile, "unrestricted">;
}

export interface SubagentHostBridge {
  list(): Promise<ReadonlyArray<SubagentSnapshot>>;
  subscribe(listener: () => void): Promise<() => void>;
  spawn(
    ctx: ExtensionContext,
    request: HostSpawnRequest,
  ): Promise<SubagentSnapshot>;
  takeover(ctx: ExtensionContext, id: string): Promise<void>;
  abort(id: string): Promise<void>;
}

const HOST_REGISTRY = Symbol.for("pi.subagents.host-bridge");

type HostRegistry = typeof globalThis & {
  [HOST_REGISTRY]?: SubagentHostBridge;
};

function registry() {
  return globalThis as HostRegistry;
}

export function registerSubagentHost(host: SubagentHostBridge | undefined) {
  if (host) registry()[HOST_REGISTRY] = host;
  else delete registry()[HOST_REGISTRY];
}

export function getSubagentHost() {
  return registry()[HOST_REGISTRY];
}
