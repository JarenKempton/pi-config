import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  AgentModelOption,
  AgentRuntimeOption,
  ReasoningEffort,
} from "./types.ts";

const EFFORTS: ReasoningEffort[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function run(file: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 10_000 },
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

function piEfforts(model: {
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<ReasoningEffort, unknown | null>>;
}) {
  if (!model.reasoning) return ["off"] satisfies ReasoningEffort[];
  return EFFORTS.filter(
    (effort) => model.thinkingLevelMap?.[effort] !== null,
  );
}

function piCatalog(ctx: ExtensionContext): AgentRuntimeOption {
  const models: AgentModelOption[] = [
    {
      id: "inherit",
      label: "Inherit current Pi model",
      efforts: EFFORTS,
      defaultEffort: "high",
    },
    ...ctx.modelRegistry
      .getAvailable()
      .map((model) => {
        const efforts = piEfforts(model);
        return {
          id: `${model.provider}/${model.id}`,
          label: `${ctx.modelRegistry.getProviderDisplayName(model.provider)} · ${model.name}`,
          efforts,
          defaultEffort: efforts.includes("medium")
            ? ("medium" as const)
            : efforts[0] ?? ("off" as const),
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label)),
  ];
  return { id: "Pi", source: "Live Pi model registry", models };
}

async function claudeCatalog(): Promise<AgentRuntimeOption> {
  try {
    const help = await run("claude", ["--help"]);
    const effortMatch = help.match(/--effort\s+<level>[\s\S]*?\(([^)]+)\)/);
    const supported = (effortMatch?.[1] ?? "low, medium, high, xhigh, max")
      .split(",")
      .map((value) => value.trim())
      .filter((value): value is ReasoningEffort =>
        EFFORTS.includes(value as ReasoningEffort),
      );
    const aliasMatch = help.match(/alias for the latest model[\s\S]*?e\.g\.\s*['"]([^'"]+)['"],\s*['"]([^'"]+)['"]\s*or\s*['"]([^'"]+)['"]/i);
    const aliases = aliasMatch
      ? [aliasMatch[1], aliasMatch[2], aliasMatch[3]].filter(
          (value): value is string => Boolean(value),
        )
      : ["fable", "opus", "sonnet"];
    const efforts = supported.length ? supported : ["high" as const];
    const models: AgentModelOption[] = [
      {
        id: "default",
        label: "Claude CLI configured default",
        efforts,
        defaultEffort: efforts.includes("high") ? "high" : efforts[0]!,
      },
      ...aliases.map((alias) => ({
        id: alias,
        label: alias[0]!.toUpperCase() + alias.slice(1),
        efforts,
        defaultEffort: efforts.includes("high")
          ? ("high" as const)
          : efforts[0]!,
      })),
    ];
    return { id: "Claude", source: "Live Claude CLI capabilities", models };
  } catch {
    return { id: "Claude", source: "Claude CLI unavailable", models: [] };
  }
}

interface CodexCache {
  fetched_at?: string;
  models?: Array<{
    slug?: string;
    display_name?: string;
    visibility?: string;
    supported_in_api?: boolean;
    default_reasoning_level?: string;
    supported_reasoning_levels?: Array<{ effort?: string }>;
  }>;
}

async function codexCatalog(): Promise<AgentRuntimeOption> {
  try {
    const cachePath = path.join(os.homedir(), ".codex", "models_cache.json");
    const cache = JSON.parse(await readFile(cachePath, "utf8")) as CodexCache;
    const models = (cache.models ?? [])
      .filter(
        (model) =>
          model.slug &&
          model.visibility === "list" &&
          model.supported_in_api !== false,
      )
      .map((model): AgentModelOption => {
        const efforts = (model.supported_reasoning_levels ?? [])
          .map((level) => level.effort ?? "")
          .filter((effort): effort is ReasoningEffort =>
            EFFORTS.includes(effort as ReasoningEffort),
          );
        const available = efforts.length ? efforts : ["medium" as const];
        const preferred = model.default_reasoning_level as ReasoningEffort;
        return {
          id: model.slug!,
          label: model.display_name ?? model.slug!,
          efforts: available,
          defaultEffort: available.includes(preferred) ? preferred : available[0]!,
        };
      });
    const freshness = cache.fetched_at
      ? ` · cache ${new Date(cache.fetched_at).toLocaleString()}`
      : "";
    return { id: "Codex", source: `Live Codex model cache${freshness}`, models };
  } catch {
    return { id: "Codex", source: "Codex model cache unavailable", models: [] };
  }
}

export async function loadAgentCatalog(
  ctx: ExtensionContext,
): Promise<AgentRuntimeOption[]> {
  const [claude, codex] = await Promise.all([claudeCatalog(), codexCatalog()]);
  return [piCatalog(ctx), claude, codex];
}
