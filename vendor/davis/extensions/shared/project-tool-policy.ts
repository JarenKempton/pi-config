import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export type ChildSafetyProfile =
  | "scout"
  | "researcher"
  | "worker"
  | "unrestricted";

const SCOUT_TOOLS = ["read", "grep", "find", "ls"] as const;
const RESEARCHER_TOOLS = [
  ...SCOUT_TOOLS,
  "web_search",
  "web_fetch",
] as const;
const WORKER_TOOLS = [...SCOUT_TOOLS, "write", "edit"] as const;

export const CHILD_ORCHESTRATION_TOOLS = [
  "subagent_spawn",
  "subagent_wait",
  "subagent_cancel",
  "subagent_check",
  "subagent_list",
  "workflow",
  "ask_user",
] as const;

export function childToolPolicy(
  profile: ChildSafetyProfile = "scout",
  extraTools: readonly string[] = [],
) {
  if (profile === "unrestricted") {
    return { excludeTools: [...CHILD_ORCHESTRATION_TOOLS] };
  }

  const base =
    profile === "worker"
      ? WORKER_TOOLS
      : profile === "researcher"
        ? RESEARCHER_TOOLS
        : SCOUT_TOOLS;
  return { tools: [...new Set([...base, ...extraTools])] };
}

export function isWithinDirectory(parent: string, child: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative === "" ||
    (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function nearestExistingPath(candidate: string) {
  let current = candidate;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

/**
 * Reject lexical traversal and symlink escapes before a worker file tool runs.
 * The OS may resolve a path through an existing symlink even when the original
 * string appears to be beneath cwd, so both forms must remain inside the root.
 */
export function assertProjectPath(cwd: string, input: unknown) {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("Worker file tools require a non-empty path.");
  }

  const lexicalRoot = path.resolve(cwd);
  const candidate = path.resolve(lexicalRoot, input);
  if (!isWithinDirectory(lexicalRoot, candidate)) {
    throw new Error(`Worker write is outside the current project: ${input}`);
  }

  const realRoot = fs.realpathSync(lexicalRoot);
  const existing = nearestExistingPath(candidate);
  const realExisting = fs.realpathSync(existing);
  if (!isWithinDirectory(realRoot, realExisting)) {
    throw new Error(`Worker write escapes the current project through a symlink: ${input}`);
  }

  if (fs.existsSync(candidate)) {
    const realCandidate = fs.realpathSync(candidate);
    if (!isWithinDirectory(realRoot, realCandidate)) {
      throw new Error(`Worker write resolves outside the current project: ${input}`);
    }
  }
}

interface ToolRegistry {
  getAllTools(): Array<{ name: string }>;
  getToolDefinition(name: string): ToolDefinition | undefined;
}

/** Wrap Pi's mutating file tools because their cwd is a resolution base, not a boundary. */
export function createProjectWriteGuard(cwd: string) {
  const wrapped = new WeakSet<ToolDefinition>();

  const wrap = (definition: ToolDefinition) => {
    if (wrapped.has(definition)) return;
    wrapped.add(definition);
    const execute = definition.execute;
    definition.execute = async (toolCallId, params, signal, onUpdate, ctx) => {
      assertProjectPath(cwd, (params as { path?: unknown })?.path);
      return execute.call(
        definition,
        toolCallId,
        params,
        signal,
        onUpdate,
        ctx,
      );
    };
  };

  return {
    apply(session: ToolRegistry) {
      for (const name of ["write", "edit"]) {
        const definition = session.getToolDefinition(name);
        if (definition) wrap(definition);
      }
    },
  };
}
