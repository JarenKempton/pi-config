#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const CACHE = join(homedir(), ".pi/agent/private/claude-rate-limits.json");
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const COLORS = {
  model: "\x1b[2;36m",
  effort: "\x1b[2;35m",
  good: "\x1b[2;32m",
  warn: "\x1b[2;33m",
  hot: "\x1b[2;31m",
  directory: "\x1b[2;34m",
  branch: "\x1b[2;37m",
  worktree: "\x1b[2;35m",
  dirty: "\x1b[2;33m",
};

function readStdin() {
  try {
    const chunks = [];
    let total = 0;
    for (;;) {
      const buffer = Buffer.alloc(65_536);
      const count = readSync(0, buffer, 0, buffer.length, null);
      if (!count) break;
      total += count;
      if (total > 1_048_576) return {};
      chunks.push(buffer.subarray(0, count));
    }
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function atomicWriteCache(rateLimits) {
  if (!rateLimits) return;
  process.umask(0o077);
  mkdirSync(dirname(CACHE), { recursive: true, mode: 0o700 });
  chmodSync(dirname(CACHE), 0o700);
  const payload = `${JSON.stringify(
    { observed_at: new Date().toISOString(), rate_limits: rateLimits },
    null,
    2,
  )}\n`;
  const temporary = `${CACHE}.${process.pid}.tmp`;
  const descriptor = openSync(temporary, "w", 0o600);
  try {
    writeFileSync(descriptor, payload, "utf8");
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, CACHE);
  chmodSync(CACHE, 0o600);
}

function command(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 700,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function percentColor(value) {
  const percent = Number(value);
  if (Number.isFinite(percent) && percent >= 85) return COLORS.hot;
  if (Number.isFinite(percent) && percent >= 60) return COLORS.warn;
  return COLORS.good;
}

function countdown(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return "";
  const delta = Math.max(0, timestamp * 1000 - Date.now());
  const minutes = Math.floor(delta / 60_000);
  const hours = Math.floor(delta / 3_600_000);
  const days = Math.floor(delta / 86_400_000);
  if (hours < 1) return `${minutes}m`;
  if (days < 1) return `${hours}h`;
  return `${days}d`;
}

function tokenDisplay(value) {
  const tokens = Number(value);
  if (!Number.isFinite(tokens)) return "";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`;
  if (tokens >= 1_000) return `${Math.floor(tokens / 1_000)}k`;
  return String(tokens);
}

function rateWindow(label, value) {
  if (!value || typeof value !== "object") return "";
  const used = value.used_percentage ?? value.usedPercent;
  if (used === undefined) return "";
  const rounded = Math.round(Number(used));
  const reset = countdown(value.resets_at ?? value.resetsAt);
  return `${percentColor(used)}${label} ${rounded}%${RESET}${
    reset ? `${DIM} (${reset})${RESET}` : ""
  }`;
}

function pathDisplay(cwd) {
  if (!cwd) return "";
  const home = homedir();
  return cwd === home || cwd.startsWith(`${home}/`)
    ? `~${cwd.slice(home.length)}`
    : cwd;
}

function gitSegment(cwd) {
  if (!cwd) return "";
  const gitDir = command("git", ["--no-optional-locks", "rev-parse", "--git-dir"], cwd);
  if (!gitDir) return "";
  const commonDir = command(
    "git",
    ["--no-optional-locks", "rev-parse", "--git-common-dir"],
    cwd,
  );
  let branch = command(
    "git",
    ["--no-optional-locks", "branch", "--show-current"],
    cwd,
  );
  if (!branch) branch = "detached";

  const absoluteGit = resolve(cwd, gitDir);
  const absoluteCommon = resolve(cwd, commonDir || gitDir);
  const worktree = absoluteGit !== absoluteCommon;
  const prefix = worktree
    ? `${COLORS.worktree}worktree:${cwd.split("/").filter(Boolean).at(-1)} ${COLORS.branch}`
    : COLORS.branch;
  const dirty = command(
    "git",
    ["--no-optional-locks", "status", "--porcelain"],
    cwd,
  );
  return `${prefix}${branch}${RESET}${dirty ? ` ${COLORS.dirty}*${RESET}` : ""}`;
}

function render(input) {
  const segments = [];
  const model = input?.model?.display_name ?? input?.model?.name;
  const effort = input?.effort?.level;
  if (model) segments.push(`${COLORS.model}${model}${RESET}`);
  if (effort) segments.push(`${COLORS.effort}${effort}${RESET}`);

  const context = input?.context_window ?? {};
  const usedPercent = context.used_percentage;
  if (usedPercent !== undefined) {
    const tokens = tokenDisplay(context.total_input_tokens);
    segments.push(
      `${percentColor(usedPercent)}${tokens ? `${tokens} tok ` : ""}(${Math.round(Number(usedPercent))}%)${RESET}`,
    );
  }

  const limits = input?.rate_limits ?? input?.rateLimits;
  const windows = [
    rateWindow("5h", limits?.five_hour),
    rateWindow("7d", limits?.seven_day),
  ].filter(Boolean);
  if (windows.length) segments.push(windows.join(" "));

  const cwd = input?.workspace?.current_dir ?? input?.cwd;
  if (cwd) segments.push(`${COLORS.directory}${pathDisplay(cwd)}${RESET}`);
  const git = gitSegment(cwd);
  if (git) segments.push(git);
  return segments.join(`${DIM} · ${RESET}`);
}

const input = readStdin();
const rateLimits = input?.rate_limits ?? input?.rateLimits;
atomicWriteCache(rateLimits);
process.stdout.write(render(input));
