import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  BACKEND_NAMES,
  REASONING_EFFORTS,
  SUBAGENT_PROFILES,
  type BackendName,
  type ReasoningEffort,
  type SubagentProfile,
} from "./domain.ts";

export interface HarnessDefaults {
  readonly model?: string;
  readonly reasoningEffort?: ReasoningEffort;
  readonly profile?: SubagentProfile;
}

export interface SubagentPreset extends HarnessDefaults {
  readonly harness: BackendName;
}

export interface SubagentConfig {
  readonly version: 1;
  readonly defaultHarness: BackendName;
  readonly defaults: Record<BackendName, HarnessDefaults>;
  readonly presets: Record<string, SubagentPreset>;
}

export interface SpawnConfigInput extends HarnessDefaults {
  readonly harness?: BackendName;
  readonly preset?: string;
}

export interface ResolvedSpawnConfig extends HarnessDefaults {
  readonly harness: BackendName;
  readonly preset?: string;
}

export const DEFAULT_SUBAGENT_CONFIG: SubagentConfig = {
  version: 1,
  defaultHarness: "pi",
  defaults: {
    pi: {},
    claude: { model: "fable", reasoningEffort: "high", profile: "scout" },
    codex: { model: "gpt-5.6-sol", reasoningEffort: "high", profile: "scout" },
    cursor: { model: "auto", profile: "scout" },
  },
  presets: {
    "cursor-kimi": { harness: "cursor", model: "kimi-k3-high", profile: "scout" },
    "cursor-gemini": {
      harness: "cursor",
      model: "gemini-3.6-flash-high",
      profile: "scout",
    },
    "security-review": {
      harness: "cursor",
      model: "kimi-k3-high",
      profile: "researcher",
    },
  },
};

export function subagentConfigPath() {
  return path.join(getAgentDir(), "pi-config", "subagents.json");
}

function isBackend(value: unknown): value is BackendName {
  return typeof value === "string" && BACKEND_NAMES.includes(value as BackendName);
}

function isEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && REASONING_EFFORTS.includes(value as ReasoningEffort);
}

function isProfile(value: unknown): value is SubagentProfile {
  return typeof value === "string" && SUBAGENT_PROFILES.includes(value as SubagentProfile);
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function harnessDefaults(value: unknown): HarnessDefaults {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const model = optionalString(record.model);
  const reasoningEffort = isEffort(record.reasoningEffort)
    ? record.reasoningEffort
    : undefined;
  const profile = isProfile(record.profile) ? record.profile : undefined;
  return {
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(profile ? { profile } : {}),
  };
}

export function parseSubagentConfig(value: unknown): SubagentConfig {
  if (!value || typeof value !== "object") return structuredClone(DEFAULT_SUBAGENT_CONFIG);
  const record = value as Record<string, unknown>;
  const rawDefaults =
    record.defaults && typeof record.defaults === "object"
      ? (record.defaults as Record<string, unknown>)
      : {};
  const defaults = Object.fromEntries(
    BACKEND_NAMES.map((backend) => {
      const raw = rawDefaults[backend];
      const parsed = {
        ...DEFAULT_SUBAGENT_CONFIG.defaults[backend],
        ...harnessDefaults(raw),
      };
      if (raw && typeof raw === "object") {
        const rawRecord = raw as Record<string, unknown>;
        if (Object.hasOwn(rawRecord, "model") && rawRecord.model === null) {
          delete parsed.model;
        }
        if (
          Object.hasOwn(rawRecord, "reasoningEffort") &&
          rawRecord.reasoningEffort === null
        ) {
          delete parsed.reasoningEffort;
        }
      }
      return [backend, parsed];
    }),
  ) as Record<BackendName, HarnessDefaults>;

  if (
    defaults.cursor.profile !== undefined &&
    defaults.cursor.profile !== "scout" &&
    defaults.cursor.profile !== "researcher"
  ) {
    defaults.cursor = { ...defaults.cursor, profile: "scout" };
  }

  const presets: Record<string, SubagentPreset> = {};
  if (record.presets && typeof record.presets === "object") {
    for (const [name, raw] of Object.entries(record.presets as Record<string, unknown>)) {
      if (!name.trim() || !raw || typeof raw !== "object") continue;
      const presetRecord = raw as Record<string, unknown>;
      if (!isBackend(presetRecord.harness)) continue;
      const parsed = { harness: presetRecord.harness, ...harnessDefaults(raw) };
      presets[name] =
        parsed.harness === "cursor" &&
        parsed.profile !== undefined &&
        parsed.profile !== "scout" &&
        parsed.profile !== "researcher"
          ? { ...parsed, profile: "scout" }
          : parsed;
    }
  } else {
    Object.assign(presets, DEFAULT_SUBAGENT_CONFIG.presets);
  }

  return {
    version: 1,
    defaultHarness: isBackend(record.defaultHarness)
      ? record.defaultHarness
      : DEFAULT_SUBAGENT_CONFIG.defaultHarness,
    defaults,
    presets,
  };
}

export async function loadSubagentConfig(): Promise<SubagentConfig> {
  try {
    return parseSubagentConfig(
      JSON.parse(await readFile(subagentConfigPath(), "utf8")) as unknown,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(
        `Unable to load subagent settings; using safe defaults: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return structuredClone(DEFAULT_SUBAGENT_CONFIG);
  }
}

export function serializeSubagentConfig(config: SubagentConfig) {
  const persisted = {
    ...config,
    defaults: Object.fromEntries(
      BACKEND_NAMES.map((backend) => {
        const defaults = config.defaults[backend];
        return [
          backend,
          {
            ...defaults,
            model: defaults.model ?? null,
            reasoningEffort: defaults.reasoningEffort ?? null,
          },
        ];
      }),
    ),
  };
  return `${JSON.stringify(persisted, null, 2)}\n`;
}

export async function saveSubagentConfig(config: SubagentConfig) {
  const target = subagentConfigPath();
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, serializeSubagentConfig(config), {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, target);
}

export function resolveSpawnConfig(
  config: SubagentConfig,
  input: SpawnConfigInput,
): ResolvedSpawnConfig {
  const preset = input.preset ? config.presets[input.preset] : undefined;
  if (input.preset && !preset) {
    throw new Error(
      `Unknown subagent preset "${input.preset}". Available: ${Object.keys(config.presets).join(", ") || "none"}.`,
    );
  }
  if (input.harness && preset && input.harness !== preset.harness) {
    throw new Error(
      `Preset "${input.preset}" uses ${preset.harness}, but explicit harness ${input.harness} was requested. Remove one or choose a matching harness.`,
    );
  }
  const harness = input.harness ?? preset?.harness ?? config.defaultHarness;
  const defaults = config.defaults[harness] ?? {};
  return {
    harness,
    preset: input.preset,
    model: input.model ?? preset?.model ?? defaults.model,
    reasoningEffort:
      input.reasoningEffort ?? preset?.reasoningEffort ?? defaults.reasoningEffort,
    profile: input.profile ?? preset?.profile ?? defaults.profile,
  };
}
