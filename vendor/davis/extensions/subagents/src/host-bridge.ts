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

let activeHost: SubagentHostBridge | undefined;

export function registerSubagentHost(host: SubagentHostBridge | undefined) {
  activeHost = host;
}

export function getSubagentHost() {
  return activeHost;
}
