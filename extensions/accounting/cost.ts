import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type Period = "today" | "7d" | "30d" | "all";

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
}

export interface UsageRow extends TokenUsage {
  source: string;
  provider: string;
  model: string;
  turns: number;
  apiEquivalentUsd: number;
  rateKnown: boolean;
}

export interface CostReport {
  period: Period;
  since: number | null;
  generatedAt: string;
  rows: UsageRow[];
  total: UsageRow;
  skipped: Record<string, number>;
  notes: string[];
}

interface Rate {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

const DAY = 24 * 60 * 60 * 1000;

// USD per million tokens, sourced from the vendors' public API pricing pages.
// Pi-native rows prefer the exact per-category cost already recorded by Pi.
const RATES: Record<string, Rate> = {
  "claude-fable-5": rate(10, 50),
  "claude-mythos-5": rate(10, 50),
  "claude-opus-4-8": rate(5, 25),
  "claude-opus-4-7": rate(5, 25),
  "claude-opus-4-6": rate(5, 25),
  "claude-opus-4-5": rate(5, 25),
  "claude-opus-4-1": rate(15, 75),
  "claude-opus-4": rate(15, 75),
  "claude-sonnet-5": rate(2, 10),
  "claude-sonnet-4-6": rate(3, 15),
  "claude-sonnet-4-5": rate(3, 15),
  "claude-sonnet-4": rate(3, 15),
  "claude-haiku-4-5": rate(1, 5),
  "claude-3-5-haiku": rate(0.8, 4),
  "gpt-5": openAiRate(1.25, 10, 0.125),
  "gpt-5-mini": openAiRate(0.25, 2, 0.025),
  "gpt-5-nano": openAiRate(0.05, 0.4, 0.005),
  "gpt-4.1": openAiRate(2, 8, 0.5),
  "gpt-4.1-mini": openAiRate(0.4, 1.6, 0.1),
  "gpt-4o": openAiRate(2.5, 10, 1.25),
};

function rate(input: number, output: number): Rate {
  return {
    input,
    output,
    cacheRead: input * 0.1,
    cacheWrite5m: input * 1.25,
    cacheWrite1h: input * 2,
  };
}

function openAiRate(input: number, output: number, cacheRead: number): Rate {
  return { input, output, cacheRead, cacheWrite5m: input, cacheWrite1h: input };
}

function n(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function firstNumber(...values: unknown[]): number {
  for (const value of values) {
    const found = n(value);
    if (found) return found;
  }
  return 0;
}

function timestamp(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function usageFromObject(usage: any): TokenUsage {
  const input = firstNumber(
    usage?.input,
    usage?.inputTokens,
    usage?.input_tokens,
    usage?.prompt_tokens,
    usage?.promptTokens,
  );
  const output = firstNumber(
    usage?.output,
    usage?.outputTokens,
    usage?.output_tokens,
    usage?.completion_tokens,
    usage?.completionTokens,
  );
  const cacheRead = firstNumber(
    usage?.cacheRead,
    usage?.cache_read,
    usage?.cachedInput,
    usage?.cached_input_tokens,
    usage?.cache_read_input_tokens,
    usage?.read_cache_input_tokens,
  );
  const cacheWrite = firstNumber(
    usage?.cacheWrite,
    usage?.cache_write,
    usage?.cache_creation_input_tokens,
    usage?.cacheCreationInputTokens,
  );
  const reasoning = firstNumber(
    usage?.reasoning,
    usage?.reasoning_output_tokens,
    usage?.reasoningOutputTokens,
  );
  const total =
    firstNumber(usage?.totalTokens, usage?.total_tokens, usage?.total) ||
    input + output + cacheRead + cacheWrite;
  return { input, output, cacheRead, cacheWrite, reasoning, total };
}

function periodSince(period: Period, now: Date): number | null {
  if (period === "all") return null;
  if (period === "today") {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }
  return now.getTime() - (period === "7d" ? 7 : 30) * DAY;
}

async function* walk(dir: string): AsyncGenerator<string> {
  if (!existsSync(dir)) return;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(file);
    else if (entry.isFile() && /\.jsonl$/i.test(entry.name)) yield file;
  }
}

function add(
  rows: Map<string, UsageRow>,
  source: string,
  provider: string,
  model: string,
  usage: TokenUsage,
  estimate?: number,
) {
  const key = `${source}\u0000${provider}\u0000${model}`;
  let row = rows.get(key);
  if (!row) {
    row = {
      source,
      provider,
      model,
      turns: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      total: 0,
      apiEquivalentUsd: 0,
      rateKnown: true,
    };
    rows.set(key, row);
  }
  row.turns++;
  row.input += usage.input;
  row.output += usage.output;
  row.cacheRead += usage.cacheRead;
  row.cacheWrite += usage.cacheWrite;
  row.reasoning += usage.reasoning;
  row.total += usage.total;
  if (estimate === undefined) row.rateKnown = false;
  else row.apiEquivalentUsd += estimate;
}

function staticRateFor(model: string) {
  const normalized = model.toLowerCase().replace(/\./g, "-").split("/").at(-1) ?? "";
  let best: string | undefined;
  for (const key of Object.keys(RATES)) {
    const matches = normalized === key || normalized.startsWith(`${key}-20`);
    if (matches && (!best || key.length > best.length)) best = key;
  }
  return best ? RATES[best] : undefined;
}

function modelRate(
  model: string,
  inferredRates: ReadonlyMap<string, Rate>,
): Rate | undefined {
  return inferredRates.get(model.toLowerCase()) ?? staticRateFor(model);
}

function estimate(
  usage: TokenUsage,
  model: string,
  inferredRates: ReadonlyMap<string, Rate>,
  options: {
    cacheWrite5m?: number;
    cacheWrite1h?: number;
    webSearches?: number;
    multiplier?: number;
  } = {},
) {
  let prices = modelRate(model, inferredRates);
  if (!prices) return undefined;
  const multiplier = options.multiplier ?? 1;
  prices = {
    input: prices.input * multiplier,
    output: prices.output * multiplier,
    cacheRead: prices.cacheRead * multiplier,
    cacheWrite5m: prices.cacheWrite5m * multiplier,
    cacheWrite1h: prices.cacheWrite1h * multiplier,
  };
  const explicitCacheWrites =
    options.cacheWrite5m !== undefined || options.cacheWrite1h !== undefined;
  const cacheWriteCost = explicitCacheWrites
    ? (options.cacheWrite5m ?? 0) * prices.cacheWrite5m +
      (options.cacheWrite1h ?? 0) * prices.cacheWrite1h
    : usage.cacheWrite * prices.cacheWrite1h;
  return (
    (usage.input * prices.input +
      usage.output * prices.output +
      usage.cacheRead * prices.cacheRead +
      cacheWriteCost) /
      1_000_000 +
    (options.webSearches ?? 0) * 0.01
  );
}

function inferRate(usage: any, model: string, inferredRates: Map<string, Rate>) {
  const tokens = usageFromObject(usage);
  const costs = usage?.cost;
  if (!costs || !model || model === "unknown") return;
  const perMillion = (cost: unknown, count: number) =>
    typeof cost === "number" && Number.isFinite(cost) && count > 0
      ? (cost * 1_000_000) / count
      : undefined;
  const input = perMillion(costs.input, tokens.input);
  const output = perMillion(costs.output, tokens.output);
  const cacheRead = perMillion(costs.cacheRead, tokens.cacheRead);
  if (input === undefined || output === undefined) return;
  inferredRates.set(model.toLowerCase(), {
    input,
    output,
    cacheRead: cacheRead ?? input,
    cacheWrite5m: input,
    cacheWrite1h: input,
  });
}

function recordedPiCost(usage: any) {
  const value = usage?.cost?.total;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function hashEvent(source: string, file: string, lineNo: number, obj: unknown) {
  return createHash("sha256")
    .update(source)
    .update(file)
    .update(String(lineNo))
    .update(JSON.stringify(obj))
    .digest("hex");
}

async function parsePi(
  paths: string[],
  since: number | null,
  rows: Map<string, UsageRow>,
  skipped: Record<string, number>,
  seen: Set<string>,
  inferredRates: Map<string, Rate>,
) {
  for (const root of paths) {
    for await (const file of walk(root)) {
      const fallback = statSync(file).mtimeMs;
      const lines = (await readFile(file, "utf8")).split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        if (!lines[index]?.trim()) continue;
        let obj: any;
        try {
          obj = JSON.parse(lines[index]);
        } catch {
          skipped.pi = (skipped.pi ?? 0) + 1;
          continue;
        }
        const message = obj.message ?? obj;
        if (obj.type && obj.type !== "message") continue;
        if (message.role !== "assistant" || !message.usage) continue;
        const at = timestamp(
          obj.timestamp ?? message.timestamp ?? obj.createdAt,
          fallback,
        );
        if (since !== null && at < since) continue;
        const id = obj.id ?? message.id ?? hashEvent("pi", file, index, obj);
        if (seen.has(`pi:${id}`)) continue;
        seen.add(`pi:${id}`);
        const model = String(message.model ?? obj.model ?? "unknown");
        inferRate(message.usage, model, inferredRates);
        const usage = usageFromObject(message.usage);
        add(
          rows,
          "Pi",
          String(message.provider ?? obj.provider ?? "unknown"),
          model,
          usage,
          recordedPiCost(message.usage) ?? estimate(usage, model, inferredRates),
        );
      }
    }
  }
}

async function parseCodex(
  paths: string[],
  since: number | null,
  rows: Map<string, UsageRow>,
  skipped: Record<string, number>,
  seen: Set<string>,
  inferredRates: ReadonlyMap<string, Rate>,
) {
  for (const root of paths) {
    for await (const file of walk(root)) {
      const fallback = statSync(file).mtimeMs;
      let currentModel = "unknown";
      let previousUsageFingerprint: string | undefined;
      const lines = (await readFile(file, "utf8")).split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        if (!lines[index]?.trim()) continue;
        let obj: any;
        try {
          obj = JSON.parse(lines[index]);
        } catch {
          skipped.codex = (skipped.codex ?? 0) + 1;
          continue;
        }
        const payload = obj.payload ?? obj;
        if (obj.type === "turn_context" || obj.type === "session_meta") {
          currentModel = String(
            payload.model ?? payload.model_slug ?? currentModel,
          );
        }
        const raw = payload?.info?.last_token_usage ?? payload?.last_token_usage;
        if (!raw) continue;
        const usageFingerprint = JSON.stringify(raw);
        // The CLI can emit the same final token_count notification twice in a
        // row for one turn. Non-consecutive equal usage remains a valid turn.
        if (usageFingerprint === previousUsageFingerprint) continue;
        previousUsageFingerprint = usageFingerprint;
        const at = timestamp(
          obj.timestamp ?? payload.timestamp ?? obj.created_at,
          fallback,
        );
        if (since !== null && at < since) continue;
        const id = obj.id ?? hashEvent("codex", file, index, obj);
        if (seen.has(`codex:${id}`)) continue;
        seen.add(`codex:${id}`);
        const model = String(raw.model ?? currentModel);
        const usage = usageFromObject(raw);
        // Codex input_tokens includes cached_input_tokens; show mutually
        // exclusive columns and avoid charging the cached portion twice.
        usage.input = Math.max(0, usage.input - usage.cacheRead);
        add(
          rows,
          "Codex CLI",
          "openai-codex",
          model,
          usage,
          estimate(usage, model, inferredRates),
        );
      }
    }
  }
}

async function parseClaude(
  paths: string[],
  since: number | null,
  rows: Map<string, UsageRow>,
  skipped: Record<string, number>,
  seen: Set<string>,
  inferredRates: ReadonlyMap<string, Rate>,
) {
  for (const root of paths) {
    for await (const file of walk(root)) {
      const fallback = statSync(file).mtimeMs;
      const lines = (await readFile(file, "utf8")).split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        if (!lines[index]?.trim()) continue;
        let obj: any;
        try {
          obj = JSON.parse(lines[index]);
        } catch {
          skipped.claude = (skipped.claude ?? 0) + 1;
          continue;
        }
        const message = obj.message ?? obj;
        const raw = message.usage ?? obj.usage;
        if (!raw) continue;
        const role = message.role ?? obj.role;
        if (role && role !== "assistant") continue;
        const at = timestamp(
          obj.timestamp ?? message.timestamp ?? obj.createdAt,
          fallback,
        );
        if (since !== null && at < since) continue;
        // Claude writes multiple transcript snapshots for one API response.
        // message.id is stable across those snapshots; uuid is not.
        const id =
          message.id ?? obj.message_id ?? obj.id ?? obj.uuid ??
          hashEvent("claude", file, index, obj);
        if (seen.has(`claude:${id}`)) continue;
        seen.add(`claude:${id}`);
        const model = String(message.model ?? obj.model ?? "unknown");
        const usage = usageFromObject(raw);
        const hasCacheDetails =
          raw.cache_creation && typeof raw.cache_creation === "object";
        const cache = hasCacheDetails ? raw.cache_creation : {};
        const speedMultiplier =
          raw.speed === "fast" && /claude-opus-4-(7|8)/i.test(model) ? 2 : 1;
        const multiplier =
          speedMultiplier * (raw.inference_geo === "us" ? 1.1 : 1);
        add(
          rows,
          "Claude Code",
          "anthropic",
          model,
          usage,
          estimate(usage, model, inferredRates, {
            cacheWrite5m: hasCacheDetails
              ? n(cache.ephemeral_5m_input_tokens)
              : undefined,
            cacheWrite1h: hasCacheDetails
              ? n(cache.ephemeral_1h_input_tokens)
              : undefined,
            webSearches: n(raw.server_tool_use?.web_search_requests),
            multiplier,
          }),
        );
      }
    }
  }
}

export async function collectCostReport(
  options: {
    period?: Period;
    now?: Date;
    roots?: { pi?: string[]; codex?: string[]; claude?: string[] };
  } = {},
): Promise<CostReport> {
  const period = options.period ?? "7d";
  const now = options.now ?? new Date();
  const since = periodSince(period, now);
  const home = homedir();
  const roots = {
    pi: options.roots?.pi ?? [join(home, ".pi/agent/sessions")],
    codex: options.roots?.codex ?? [
      join(home, ".codex/sessions"),
      join(home, ".codex/archived_sessions"),
    ],
    claude: options.roots?.claude ?? [join(home, ".claude/projects")],
  };
  const rows = new Map<string, UsageRow>();
  const skipped: Record<string, number> = {};
  const seen = new Set<string>();
  const inferredRates = new Map<string, Rate>();

  await parsePi(roots.pi, since, rows, skipped, seen, inferredRates);
  await parseCodex(
    roots.codex,
    since,
    rows,
    skipped,
    seen,
    inferredRates,
  );
  await parseClaude(
    roots.claude,
    since,
    rows,
    skipped,
    seen,
    inferredRates,
  );

  const output = [...rows.values()].sort(
    (a, b) =>
      a.source.localeCompare(b.source) || a.model.localeCompare(b.model),
  );
  const total: UsageRow = {
    source: "Total",
    provider: "",
    model: "",
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 0,
    apiEquivalentUsd: 0,
    rateKnown: output.every((row) => row.rateKnown),
  };
  for (const row of output) {
    total.turns += row.turns;
    total.input += row.input;
    total.output += row.output;
    total.cacheRead += row.cacheRead;
    total.cacheWrite += row.cacheWrite;
    total.reasoning += row.reasoning;
    total.total += row.total;
    total.apiEquivalentUsd += row.apiEquivalentUsd;
  }

  const notes = [
    "API-equivalent estimates are not invoices and do not represent subscription charges.",
    "Pi rows use Pi's recorded per-request cost when available; external rows use public per-token rates or rates inferred from matching Pi model records.",
  ];
  if (output.some((row) => !row.rateKnown)) {
    notes.push(
      "Models shown as n/a had no matching public or locally inferred rate; the total is a known-cost subtotal.",
    );
  }
  if (Object.keys(skipped).length) {
    notes.push(
      `Skipped malformed JSONL lines: ${Object.entries(skipped)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ")}.`,
    );
  }
  return {
    period,
    since,
    generatedAt: now.toISOString(),
    rows: output,
    total,
    skipped,
    notes,
  };
}

const formatNumber = (value: number) => Math.round(value).toLocaleString();
const formatUsd = (row: UsageRow) =>
  row.rateKnown
    ? `$${row.apiEquivalentUsd.toFixed(row.apiEquivalentUsd >= 100 ? 2 : 4)}`
    : "n/a";

export function renderCostReport(report: CostReport): string {
  const title =
    report.period === "all"
      ? "All local history"
      : report.period === "today"
        ? "Today"
        : `Last ${report.period}`;
  const lines = [
    `# Cost (${title})`,
    "",
    "API-equivalent estimate from local history (no model calls).",
    "",
    "| Source | Provider | Model | Turns | Input | Output | Cached In | Cache Write | Reasoning | Total Tokens | API-Equivalent Estimate |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const row of [...report.rows, report.total]) {
    lines.push(
      `| ${row.source} | ${row.provider} | ${row.model} | ${formatNumber(row.turns)} | ${formatNumber(row.input)} | ${formatNumber(row.output)} | ${formatNumber(row.cacheRead)} | ${formatNumber(row.cacheWrite)} | ${formatNumber(row.reasoning)} | ${formatNumber(row.total)} | ${formatUsd(row)} |`,
    );
  }
  lines.push("", "## Notes", ...report.notes.map((note) => `- ${note}`));
  return lines.join("\n");
}
