import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolveCursorBinary } from "../../vendor/davis/extensions/subagents/src/backends/cursor.ts";
import {
  CLAUDE_CACHE_PATH,
  refreshClaudeUsageLive,
} from "./claude-usage.ts";

export { CLAUDE_CACHE_PATH } from "./claude-usage.ts";

export interface ClaudeCacheStatus {
  path: string;
  exists: boolean;
  observedAt?: string;
  ageMs?: number;
  stale: boolean;
  rateLimits?: unknown;
  error?: string;
}

export interface UsageWindow {
  id: string;
  label: string;
  usedPercent?: number;
  resetsAt?: number;
  windowDurationMins?: number;
}

export interface UsageProviderStatus {
  id: "codex" | "claude" | "cursor";
  label: string;
  source: string;
  observedAt?: string;
  ageMs?: number;
  stale: boolean;
  windows: UsageWindow[];
  error?: string;
  refreshError?: string;
}

export interface UsageStatusReport {
  generatedAt: string;
  codex: UsageProviderStatus;
  claude: UsageProviderStatus;
  cursor: UsageProviderStatus;
}

export async function readClaudeCache(
  now = Date.now(),
  path = CLAUDE_CACHE_PATH,
): Promise<ClaudeCacheStatus> {
  try {
    if (!existsSync(path)) {
      return { path, exists: false, stale: true, error: "cache missing" };
    }
    const data = JSON.parse(await readFile(path, "utf8"));
    const observedAt =
      typeof data.observed_at === "string"
        ? data.observed_at
        : typeof data.observedAt === "string"
          ? data.observedAt
          : undefined;
    const observedMs = observedAt ? Date.parse(observedAt) : NaN;
    const ageMs = Number.isFinite(observedMs) ? now - observedMs : undefined;
    return {
      path,
      exists: true,
      observedAt,
      ageMs,
      stale: ageMs === undefined || ageMs > 10 * 60 * 1000,
      rateLimits: data.rate_limits ?? data.rateLimits,
    };
  } catch (error) {
    return {
      path,
      exists: true,
      stale: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function requestFromCodex(timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let stderr = "";
    let settled = false;

    const finish = (outcome: { value: unknown } | { error: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      if ("error" in outcome) reject(outcome.error);
      else resolve(outcome.value);
    };
    const write = (message: unknown) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === 0) {
        if (message.error) {
          finish({ error: new Error(JSON.stringify(message.error)) });
          return;
        }
        write({ method: "initialized" });
        write({ id: 1, method: "account/rateLimits/read", params: {} });
        return;
      }
      if (message.id === 1) {
        finish(
          message.error
            ? { error: new Error(JSON.stringify(message.error)) }
            : { value: message.result },
        );
      }
    };

    const timer = setTimeout(
      () =>
        finish({
          error: new Error(`codex app-server timed out after ${timeoutMs}ms`),
        }),
      timeoutMs,
    );
    child.stdout.on("data", (data) => {
      buffer += data.toString();
      if (buffer.length > 1_048_576) {
        finish({ error: new Error("codex app-server response exceeded 1 MiB") });
        return;
      }
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        handleLine(line);
      }
    });
    child.stderr.on("data", (data) => {
      stderr = `${stderr}${data.toString()}`.slice(-4096);
    });
    child.stdin.on("error", (error) => finish({ error }));
    child.on("error", (error) => finish({ error }));
    child.on("exit", () => {
      if (!settled) {
        finish({
          error: new Error(
            stderr.trim() || "codex app-server exited without a response",
          ),
        });
      }
    });
    write({
      id: 0,
      method: "initialize",
      params: { clientInfo: { name: "pi-usage", version: "0.2.0" } },
    });
  });
}

export async function readCodexRateLimits(
  timeoutMs = 5000,
): Promise<
  | { ok: true; data: unknown; observedAt: string }
  | { ok: false; error: string }
> {
  try {
    const data = await requestFromCodex(timeoutMs);
    return { ok: true, data, observedAt: new Date().toISOString() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function resetTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function windowFrom(
  id: string,
  label: string,
  value: any,
): UsageWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usedPercent = finiteNumber(
    value.usedPercent ??
      value.used_percentage ??
      value.percentUsed ??
      value.percent_used,
  );
  const resetsAt = resetTimestamp(
    value.resetsAt ?? value.resets_at ?? value.resetAt ?? value.reset_at,
  );
  const windowDurationMins = finiteNumber(
    value.windowDurationMins ?? value.window_duration_mins,
  );
  if (
    usedPercent === undefined &&
    resetsAt === undefined &&
    windowDurationMins === undefined
  ) {
    return undefined;
  }
  return {
    id,
    label,
    usedPercent,
    resetsAt,
    windowDurationMins,
  };
}

export function parseClaudeUsageWindows(value: any): UsageWindow[] {
  if (!value || typeof value !== "object") return [];
  return [
    windowFrom("five-hour", "5-hour window", value.five_hour),
    windowFrom("seven-day", "7-day window", value.seven_day),
  ].filter((window): window is UsageWindow => window !== undefined);
}

function codexBucketWindows(id: string, bucket: any): UsageWindow[] {
  if (!bucket || typeof bucket !== "object") return [];
  const label = String(bucket.limitName ?? bucket.limit_name ?? id);
  return [
    windowFrom(`${id}:primary`, label, bucket.primary ?? bucket),
    windowFrom(`${id}:secondary`, `${label} · secondary`, bucket.secondary),
  ].filter((window): window is UsageWindow => window !== undefined);
}

export function parseCodexUsageWindows(value: any): UsageWindow[] {
  if (!value || typeof value !== "object") return [];
  const buckets = value.rateLimitsByLimitId ?? value.rate_limits_by_limit_id;
  if (buckets && typeof buckets === "object") {
    return Object.entries(buckets)
      .sort(([left], [right]) =>
        left === "codex" ? -1 : right === "codex" ? 1 : left.localeCompare(right),
      )
      .flatMap(([id, bucket]) => codexBucketWindows(id, bucket));
  }
  const limits = value.rateLimits ?? value.rate_limits ?? value;
  if (Array.isArray(limits)) {
    return limits.flatMap((bucket, index) =>
      codexBucketWindows(String(bucket?.limitId ?? index), bucket),
    );
  }
  return codexBucketWindows(String(limits?.limitId ?? "codex"), limits);
}

export async function readCursorAccountStatus(
  timeoutMs = 5_000,
): Promise<UsageProviderStatus> {
  const observedAt = new Date().toISOString();
  try {
    const data = await new Promise<any>((resolve, reject) => {
      const binary = resolveCursorBinary();
      if (!binary) {
        reject(new Error("cursor-agent executable was not found"));
        return;
      }
      execFile(
        binary,
        ["about", "--format", "json"],
        { encoding: "utf8", timeout: timeoutMs, maxBuffer: 256 * 1024 },
        (error, stdout, stderr) => {
          if (error) reject(new Error(String(stderr).trim() || error.message));
          else {
            try {
              resolve(JSON.parse(stdout));
            } catch (parseError) {
              reject(parseError);
            }
          }
        },
      );
    });
    const details = [
      typeof data.subscriptionTier === "string" ? `${data.subscriptionTier} subscription` : undefined,
      typeof data.model === "string" ? data.model : undefined,
    ].filter(Boolean).join(" · ");
    return {
      id: "cursor",
      label: "Cursor",
      source: details || "Cursor CLI account",
      observedAt,
      ageMs: 0,
      stale: false,
      // Cursor CLI exposes authentication, tier, and active model, but no
      // deterministic subscription quota windows. Do not invent percentages.
      windows: [],
    };
  } catch (error) {
    return {
      id: "cursor",
      label: "Cursor",
      source: "Cursor CLI account",
      stale: true,
      windows: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function collectUsageStatus(
  now = Date.now(),
  options: { refreshClaude?: boolean } = {},
): Promise<UsageStatusReport> {
  const [codexResult, claudeRefresh, cursor] = await Promise.all([
    readCodexRateLimits(),
    options.refreshClaude
      ? refreshClaudeUsageLive()
      : Promise.resolve(undefined),
    readCursorAccountStatus(),
  ]);
  const claudeCache = await readClaudeCache(
    options.refreshClaude ? Date.now() : now,
  );
  const codex: UsageProviderStatus = codexResult.ok
    ? {
        id: "codex",
        label: "Codex",
        source: "live account limits",
        observedAt: codexResult.observedAt,
        ageMs: Math.max(0, now - Date.parse(codexResult.observedAt)),
        stale: false,
        windows: parseCodexUsageWindows(codexResult.data),
      }
    : {
        id: "codex",
        label: "Codex",
        source: "live account limits",
        stale: true,
        windows: [],
        error: "error" in codexResult ? codexResult.error : "unknown error",
      };
  const claude: UsageProviderStatus = {
    id: "claude",
    label: "Claude",
    source: claudeRefresh?.ok
      ? "live account limits"
      : "local usage cache",
    observedAt: claudeCache.observedAt,
    ageMs: claudeCache.ageMs,
    stale: claudeCache.stale,
    windows: parseClaudeUsageWindows(claudeCache.rateLimits),
    error: claudeCache.error,
    refreshError:
      claudeRefresh && !claudeRefresh.ok
        ? claudeRefresh.error
        : undefined,
  };
  return {
    generatedAt: new Date(now).toISOString(),
    codex,
    claude,
    cursor,
  };
}

export function formatAge(ageMs?: number): string {
  if (ageMs === undefined || !Number.isFinite(ageMs)) return "unknown age";
  const seconds = Math.max(0, Math.floor(ageMs / 1000));
  if (seconds < 60) return `${seconds}s old`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m old`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h old`;
}

function formatReset(resetsAt?: number) {
  return resetsAt === undefined
    ? undefined
    : new Date(resetsAt).toLocaleString();
}

function summarizeWindow(window: UsageWindow) {
  const parts = [
    `${window.label}: ${window.usedPercent === undefined ? "usage unavailable" : `${window.usedPercent}% used`}`,
  ];
  const reset = formatReset(window.resetsAt);
  if (reset) parts.push(`resets ${reset}`);
  return parts.join(", ");
}

export function summarizeLimits(value: any): string {
  const claude = parseClaudeUsageWindows(value);
  if (claude.length) return claude.map(summarizeWindow).join("; ");
  const codex = parseCodexUsageWindows(value);
  if (codex.length) return codex.map(summarizeWindow).join("; ");
  return value ? JSON.stringify(value).slice(0, 240) : "unavailable";
}

export async function renderUsageStatus(): Promise<string> {
  const report = await collectUsageStatus();
  const lines = [
    "Usage",
    "",
    "Deterministic account/cache status; no model calls.",
    "",
    "Codex subscription windows",
  ];
  if (report.codex.error) lines.push(`- Unavailable: ${report.codex.error}`);
  else {
    lines.push(
      ...report.codex.windows.map((window) => `- ${summarizeWindow(window)}`),
    );
  }
  lines.push("", "Claude usage cache");
  lines.push(
    `- Status: ${report.claude.stale ? "stale" : "fresh"}${
      report.claude.observedAt
        ? `, observed ${report.claude.observedAt} (${formatAge(report.claude.ageMs)})`
        : ""
    }`,
  );
  if (report.claude.error) lines.push(`- Note: ${report.claude.error}`);
  if (report.claude.refreshError) {
    lines.push(`- Live refresh failed: ${report.claude.refreshError}`);
  }
  lines.push(
    ...report.claude.windows.map((window) => `- ${summarizeWindow(window)}`),
    "",
    "Cursor CLI account",
    `- Status: ${report.cursor.error ? `unavailable (${report.cursor.error})` : report.cursor.source}`,
    "- Cursor CLI does not expose deterministic subscription quota windows.",
    "",
    "No private Claude or Cursor endpoint or credentials are used.",
  );
  return lines.join("\n");
}
