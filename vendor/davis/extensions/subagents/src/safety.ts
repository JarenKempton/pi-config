import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentProfile } from "./domain.ts";

export const DEFAULT_SUBAGENT_PROFILE: SubagentProfile = "scout";

export function normalizeProfile(profile: unknown): SubagentProfile {
  return profile === "researcher" ||
    profile === "worker" ||
    profile === "unrestricted"
    ? profile
    : "scout";
}

export function isWithinDirectory(parent: string, child: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertCwdAllowed(parentCwd: string, childCwd: string, profile: SubagentProfile) {
  if (profile === "unrestricted") return;
  if (!isWithinDirectory(parentCwd, childCwd)) {
    throw new Error(
      `working_dir ${childCwd} is outside parent project ${parentCwd}; use profile=\"unrestricted\" with explicit UI confirmation if this is intentional.`,
    );
  }
}

export async function confirmUnrestrictedSpawn(ctx: ExtensionContext, options: { harness: string; cwd: string; title: string }) {
  if (!ctx.hasUI) {
    throw new Error("profile=\"unrestricted\" requires explicit per-spawn UI confirmation and is unavailable headlessly.");
  }
  const ok = await ctx.ui.confirm(
    "Allow unrestricted subagent?",
    `Harness: ${options.harness}\nName: ${options.title}\nWorking directory: ${options.cwd}\n\nThis child may run with full host permissions.`,
  );
  if (!ok) throw new Error("Unrestricted subagent spawn was not confirmed by the user.");
}
