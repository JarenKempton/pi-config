import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Rate {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export interface PricingCatalog {
  rates: Map<string, Rate>;
  fetchedAt?: string;
  live: boolean;
  notes: string[];
}

interface CachedCatalog {
  version: 1;
  fetchedAt: string;
  rates: Record<string, Rate>;
  providers?: string[];
}

const OPENAI_PRICING_URL =
  "https://developers.openai.com/api/docs/pricing.md";
const ANTHROPIC_PRICING_URL =
  "https://platform.claude.com/docs/en/about-claude/pricing.md";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_CACHE_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "cache",
  "model-pricing.json",
);

let memoryCatalog: PricingCatalog | undefined;
let memoryLoadedAt = 0;
let pendingLoad: Promise<PricingCatalog> | undefined;

function rate(input: number, output: number): Rate {
  return {
    input,
    output,
    cacheRead: input * 0.1,
    cacheWrite5m: input * 1.25,
    cacheWrite1h: input * 2,
  };
}

function openAiRate(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite?: number,
): Rate {
  return {
    input,
    output,
    cacheRead,
    cacheWrite5m: cacheWrite ?? input,
    cacheWrite1h: cacheWrite ?? input,
  };
}

// Last-known-good fallback only. Live official docs override these values.
export const FALLBACK_RATES: Record<string, Rate> = {
  "claude-fable-5": rate(10, 50),
  "claude-mythos-5": rate(10, 50),
  "claude-opus-5": rate(5, 25),
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
  "gpt-5-6-sol": openAiRate(5, 30, 0.5, 6.25),
  "gpt-5-6-terra": openAiRate(2, 12, 0.2, 2.5),
  "gpt-5-6-luna": openAiRate(0.2, 1.2, 0.02, 0.25),
  "gpt-5-5": openAiRate(5, 30, 0.5),
  "gpt-5-4": openAiRate(2.5, 15, 0.25),
  "gpt-5-4-mini": openAiRate(0.75, 4.5, 0.075),
  "gpt-5-4-nano": openAiRate(0.2, 1.25, 0.02),
  "gpt-5-3-codex": openAiRate(1.75, 14, 0.175),
  "gpt-5-2": openAiRate(1.75, 14, 0.175),
  "gpt-5-1": openAiRate(1.25, 10, 0.125),
  "gpt-5": openAiRate(1.25, 10, 0.125),
  "gpt-5-mini": openAiRate(0.25, 2, 0.025),
  "gpt-5-nano": openAiRate(0.05, 0.4, 0.005),
  "gpt-4-1": openAiRate(2, 8, 0.5),
  "gpt-4-1-mini": openAiRate(0.4, 1.6, 0.1),
  "gpt-4o": openAiRate(2.5, 10, 1.25),
};

export function normalizeModelName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\./g, "-")
    .replace(/[^a-z0-9/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .split("/")
    .at(-1) ?? "";
}

function dollars(value: string): number | undefined {
  if (value.trim() === "-") return undefined;
  const match = value.match(/\$\s*([\d.]+)/);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function tableRows(markdown: string): string[][] {
  return markdown
    .split(/\r?\n/)
    .filter((line) => /^\s*\|/.test(line))
    .map((line) =>
      line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim()),
    )
    .filter((cells) => !cells.every((cell) => /^[-: ]+$/.test(cell)));
}

function cleanModelCell(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+(through|starting)\s+.+$/i, "")
    .trim();
}

function rowIsEffective(value: string, now: Date): boolean {
  const through = value.match(/through\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/i);
  if (through) {
    const end = Date.parse(`${through[1]} 23:59:59Z`);
    return !Number.isFinite(end) || now.getTime() <= end;
  }
  const starting = value.match(/starting\s+([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/i);
  if (starting) {
    const start = Date.parse(`${starting[1]} 00:00:00Z`);
    return !Number.isFinite(start) || now.getTime() >= start;
  }
  return true;
}

export function parseAnthropicPricing(
  markdown: string,
  now = new Date(),
): Map<string, Rate> {
  const rates = new Map<string, Rate>();
  for (const cells of tableRows(markdown)) {
    if (cells.length < 6 || !/^claude\s/i.test(cells[0] ?? "")) continue;
    if (!rowIsEffective(cells[0]!, now)) continue;
    const input = dollars(cells[1]!);
    const cacheWrite5m = dollars(cells[2]!);
    const cacheWrite1h = dollars(cells[3]!);
    const cacheRead = dollars(cells[4]!);
    const output = dollars(cells[5]!);
    if (
      input === undefined ||
      output === undefined ||
      cacheRead === undefined ||
      cacheWrite5m === undefined ||
      cacheWrite1h === undefined
    ) continue;
    rates.set(normalizeModelName(cleanModelCell(cells[0]!)), {
      input,
      output,
      cacheRead,
      cacheWrite5m,
      cacheWrite1h,
    });
  }
  return rates;
}

function parseOpenAiTable(markdown: string, rates: Map<string, Rate>) {
  const rows = tableRows(markdown);
  for (const cells of rows) {
    if (cells.length < 5) continue;
    const model = cleanModelCell(cells[0] ?? "");
    if (!/^(gpt-|o\d)/i.test(model)) continue;
    const input = dollars(cells[1]!);
    const cacheRead = dollars(cells[2]!);
    const cacheWrite = dollars(cells[3]!);
    const output = dollars(cells[4]!);
    if (input === undefined || output === undefined) continue;
    rates.set(
      normalizeModelName(model),
      openAiRate(input, output, cacheRead ?? input, cacheWrite),
    );
  }
}

export function parseOpenAiPricing(markdown: string): Map<string, Rate> {
  const rates = new Map<string, Rate>();
  const standard = markdown
    .split("### Standard pricing data")[1]
    ?.split("### Batch pricing data")[0];
  if (standard) parseOpenAiTable(standard, rates);

  const specialized = markdown
    .split("Specialized models")[1]
    ?.split("Finetuning")[0];
  const specializedStandard = specialized
    ?.split("### Grouped Pricing Table data")[1]
    ?.split("Fast mode")[0];
  if (specializedStandard) {
    const rows = tableRows(specializedStandard);
    for (const cells of rows) {
      if (cells.length < 5) continue;
      const model = cleanModelCell(cells[1] ?? "");
      const input = dollars(cells[2]!);
      const cacheRead = dollars(cells[3]!);
      const output = dollars(cells[4]!);
      if (!model || input === undefined || output === undefined) continue;
      rates.set(
        normalizeModelName(model),
        openAiRate(input, output, cacheRead ?? input),
      );
    }
  }
  return rates;
}

async function fetchMarkdown(
  url: string,
  fetchFn: typeof fetch,
): Promise<string> {
  const response = await fetchFn(url, {
    headers: { accept: "text/markdown", "user-agent": "pi-cost-pricing/1.0" },
    signal: AbortSignal.timeout(7_500),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const text = await response.text();
  if (text.length < 100) throw new Error("response was unexpectedly short");
  return text;
}

function fromCache(
  value: CachedCatalog,
  live: boolean,
  notes: string[],
): PricingCatalog {
  return {
    rates: new Map(Object.entries(value.rates)),
    fetchedAt: value.fetchedAt,
    live,
    notes,
  };
}

async function readCache(path: string): Promise<CachedCatalog | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as CachedCatalog;
    if (parsed.version !== 1 || !parsed.fetchedAt || !parsed.rates) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

async function writeCache(path: string, catalog: CachedCatalog) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function loadPricingCatalog(
  options: {
    now?: Date;
    fetchFn?: typeof fetch;
    cachePath?: string;
    forceRefresh?: boolean;
  } = {},
): Promise<PricingCatalog> {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  if (!options.forceRefresh && memoryCatalog && nowMs - memoryLoadedAt < CACHE_TTL_MS) {
    return memoryCatalog;
  }
  if (pendingLoad) return pendingLoad;

  pendingLoad = (async () => {
    const cachePath = options.cachePath ?? DEFAULT_CACHE_PATH;
    const cached = await readCache(cachePath);
    const cachedAt = cached ? Date.parse(cached.fetchedAt) : NaN;
    if (
      !options.forceRefresh &&
      cached &&
      Number.isFinite(cachedAt) &&
      nowMs - cachedAt < CACHE_TTL_MS
    ) {
      const providers = cached.providers?.join(" and ") || "OpenAI and Anthropic";
      const notes = [
        `Official model prices cached from ${providers} at ${cached.fetchedAt}.`,
      ];
      if (cached.providers && cached.providers.length < 2) {
        notes.push("The unavailable provider is using bundled fallback rates.");
      }
      return fromCache(cached, true, notes);
    }

    const rates = new Map(Object.entries(FALLBACK_RATES));
    const errors: string[] = [];
    let successfulSources = 0;
    const fetchFn = options.fetchFn ?? fetch;
    const [openai, anthropic] = await Promise.allSettled([
      fetchMarkdown(OPENAI_PRICING_URL, fetchFn),
      fetchMarkdown(ANTHROPIC_PRICING_URL, fetchFn),
    ]);
    if (openai.status === "fulfilled") {
      const parsed = parseOpenAiPricing(openai.value);
      if (parsed.size === 0) errors.push("OpenAI pricing page contained no recognized model rows");
      else {
        for (const entry of parsed) rates.set(...entry);
        successfulSources++;
      }
    } else errors.push(`OpenAI pricing refresh failed: ${openai.reason}`);
    if (anthropic.status === "fulfilled") {
      const parsed = parseAnthropicPricing(anthropic.value, now);
      if (parsed.size === 0) errors.push("Anthropic pricing page contained no recognized model rows");
      else {
        for (const entry of parsed) rates.set(...entry);
        successfulSources++;
      }
    } else errors.push(`Anthropic pricing refresh failed: ${anthropic.reason}`);

    if (successfulSources > 0) {
      const providers = [
        openai.status === "fulfilled" && parseOpenAiPricing(openai.value).size > 0
          ? "OpenAI"
          : undefined,
        anthropic.status === "fulfilled" &&
        parseAnthropicPricing(anthropic.value, now).size > 0
          ? "Anthropic"
          : undefined,
      ].filter((provider): provider is string => provider !== undefined);
      const value: CachedCatalog = {
        version: 1,
        fetchedAt: now.toISOString(),
        rates: Object.fromEntries(rates),
        providers,
      };
      await writeCache(cachePath, value).catch(() => undefined);
      return fromCache(value, true, [
        `Refreshed official model prices from ${providers.join(" and ")} at ${value.fetchedAt}.`,
        ...errors,
      ]);
    }

    if (cached) {
      return fromCache(cached, false, [
        `Official pricing refresh failed; using cache from ${cached.fetchedAt}.`,
        ...errors,
      ]);
    }
    return {
      rates,
      live: false,
      notes: ["Official pricing refresh failed; using bundled fallback rates.", ...errors],
    };
  })();

  try {
    memoryCatalog = await pendingLoad;
    memoryLoadedAt = nowMs;
    return memoryCatalog;
  } finally {
    pendingLoad = undefined;
  }
}
