import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import {
  query,
  type SDKControlGetUsageResponse,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

export const CLAUDE_CACHE_PATH = join(
  homedir(),
  ".pi/agent/private/claude-rate-limits.json",
);

export interface ClaudeUsageQuery {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(): Promise<SDKControlGetUsageResponse>;
}

export type ClaudeUsageRefreshResult =
  | { ok: true; observedAt: string }
  | { ok: false; error: string };

type CachedWindow = {
  used_percentage: number;
  resets_at?: string;
};

type CachedRateLimits = {
  five_hour?: CachedWindow;
  seven_day?: CachedWindow;
};

class IdleClaudeInput implements AsyncIterable<SDKUserMessage> {
  private waiter:
    | ((result: IteratorResult<SDKUserMessage>) => void)
    | undefined;
  private closed = false;

  [Symbol.asyncIterator]() {
    return this;
  }

  next(): Promise<IteratorResult<SDKUserMessage>> {
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  close() {
    this.closed = true;
    this.waiter?.({ done: true, value: undefined });
    this.waiter = undefined;
  }
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeWindow(value: unknown): CachedWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const window = value as { utilization?: unknown; resets_at?: unknown };
  if (
    typeof window.utilization !== "number" ||
    !Number.isFinite(window.utilization)
  ) {
    return undefined;
  }
  return {
    used_percentage: Math.max(0, Math.min(100, window.utilization)),
    ...(typeof window.resets_at === "string"
      ? { resets_at: window.resets_at }
      : {}),
  };
}

export function normalizeClaudeUsageResponse(
  usage: SDKControlGetUsageResponse,
): CachedRateLimits | undefined {
  if (!usage.rate_limits_available || !usage.rate_limits) return undefined;
  const fiveHour = normalizeWindow(usage.rate_limits.five_hour);
  const sevenDay = normalizeWindow(usage.rate_limits.seven_day);
  if (!fiveHour && !sevenDay) return undefined;
  return {
    ...(fiveHour ? { five_hour: fiveHour } : {}),
    ...(sevenDay ? { seven_day: sevenDay } : {}),
  };
}

export async function writeClaudeUsageCache(
  rateLimits: CachedRateLimits,
  observedAt = new Date().toISOString(),
  path = CLAUDE_CACHE_PATH,
) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(
      `${JSON.stringify(
        { observed_at: observedAt, rate_limits: rateLimits },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function refreshClaudeUsageFromQuery(
  session: ClaudeUsageQuery,
  path = CLAUDE_CACHE_PATH,
): Promise<ClaudeUsageRefreshResult> {
  try {
    const usage =
      await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
    const rateLimits = normalizeClaudeUsageResponse(usage);
    if (!rateLimits) {
      return {
        ok: false,
        error: "Claude plan rate limits were unavailable or unrecognized",
      };
    }
    const observedAt = new Date().toISOString();
    await writeClaudeUsageCache(rateLimits, observedAt, path);
    return { ok: true, observedAt };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

async function executableOnPath() {
  const names =
    process.platform === "win32"
      ? ["claude.exe", "claude.cmd", "claude"]
      : ["claude"];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      try {
        await access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Keep searching; the SDK can also fall back to its bundled CLI.
      }
    }
  }
  return undefined;
}

export async function refreshClaudeUsageLive(
  options: { timeoutMs?: number; path?: string; cwd?: string } = {},
): Promise<ClaudeUsageRefreshResult> {
  const input = new IdleClaudeInput();
  const abortController = new AbortController();
  const claudeBinary = await executableOnPath();
  const session = query({
    prompt: input,
    options: {
      cwd: options.cwd ?? process.cwd(),
      settingSources: [],
      disallowedTools: ["Agent", "Task"],
      abortController,
      ...(claudeBinary
        ? { pathToClaudeCodeExecutable: claudeBinary }
        : {}),
    },
  });
  const timeoutMs = options.timeoutMs ?? 15_000;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      refreshClaudeUsageFromQuery(session, options.path),
      new Promise<ClaudeUsageRefreshResult>((resolve) => {
        timeout = setTimeout(
          () =>
            resolve({
              ok: false,
              error: `Claude usage refresh timed out after ${timeoutMs}ms`,
            }),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    input.close();
    abortController.abort();
    session.close();
  }
}
