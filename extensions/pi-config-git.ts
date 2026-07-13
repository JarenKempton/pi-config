import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HOME = process.env.HOME ?? "";
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(EXTENSION_DIR, "..");
const PI_DIR = resolve(HOME, ".pi/agent");
const GLOBAL_AGENTS_PATH = resolve(PI_DIR, "AGENTS.md");
const GLOBAL_REPO_LINK = resolve(PI_DIR, "pi-config");
const GLOBAL_MCP_PATH = resolve(PI_DIR, "mcp.json");
const BROWSER_SKILL_PATH = resolve(REPO_DIR, "skills/test-in-browser");
const CODEX_BROWSER_SKILL_LINK = resolve(HOME, ".codex/skills/test-in-browser");
const CLAUDE_BROWSER_SKILL_LINK = resolve(HOME, ".claude/skills/test-in-browser");
const WATCH_PATHS = [REPO_DIR];

function expandHome(input: string | undefined) {
  if (!input) return undefined;
  if (input === "~") return HOME;
  if (input.startsWith("~/")) return resolve(HOME, input.slice(2));
  return resolve(input);
}

function isTrackedConfigPath(inputPath: string | undefined) {
  const fullPath = expandHome(inputPath);
  if (!fullPath) return false;
  return WATCH_PATHS.some((base) => fullPath === base || fullPath.startsWith(`${base}/`));
}

function ensureSymlink(linkPath: string, targetPath: string) {
  try {
    if (existsSync(linkPath)) {
      const stat = lstatSync(linkPath);
      if (stat.isSymbolicLink() && resolve(dirname(linkPath), readlinkSync(linkPath)) === targetPath) return;
      rmSync(linkPath, { recursive: true, force: true });
    }
    symlinkSync(targetPath, linkPath);
  } catch {
    // Best-effort startup hygiene only. Do not block Pi if the filesystem refuses.
  }
}

function ensureNonDestructiveSymlink(linkPath: string, targetPath: string) {
  try {
    mkdirSync(dirname(linkPath), { recursive: true });
    if (existsSync(linkPath)) {
      const stat = lstatSync(linkPath);
      if (!stat.isSymbolicLink()) return;
      if (resolve(dirname(linkPath), readlinkSync(linkPath)) === targetPath) return;
      rmSync(linkPath, { force: true });
    }
    symlinkSync(targetPath, linkPath);
  } catch {
    // Best-effort cross-harness discovery only. The explicit bootstrap reports conflicts.
  }
}

function ensureGlobalConfigLinks() {
  ensureSymlink(GLOBAL_REPO_LINK, REPO_DIR);
  ensureSymlink(GLOBAL_AGENTS_PATH, resolve(REPO_DIR, "AGENTS.md"));
  ensureNonDestructiveSymlink(GLOBAL_MCP_PATH, resolve(REPO_DIR, "mcp.json"));
  ensureNonDestructiveSymlink(CODEX_BROWSER_SKILL_LINK, BROWSER_SKILL_PATH);
  ensureNonDestructiveSymlink(CLAUDE_BROWSER_SKILL_LINK, BROWSER_SKILL_PATH);
}

async function execGit(pi: ExtensionAPI, args: string[]) {
  return pi.exec("git", args, { cwd: REPO_DIR, timeout: 30_000 });
}

async function getStatus(pi: ExtensionAPI) {
  const result = await execGit(pi, ["status", "--short"]);
  return result.stdout.trim();
}

async function commitIfDirty(pi: ExtensionAPI, reason: string) {
  const status = await getStatus(pi);
  if (!status) return { changed: false, message: "No config changes to commit." };

  await execGit(pi, ["add", "."]);
  const afterAdd = await getStatus(pi);
  if (!afterAdd) return { changed: false, message: "No staged config changes to commit." };

  const message = `pi config: ${reason}`;
  const commit = await execGit(pi, ["commit", "-m", message]);
  if (commit.code !== 0) {
    return { changed: false, message: (commit.stderr || commit.stdout || "git commit failed").trim() };
  }

  return { changed: true, message };
}

async function pushConfig(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
  await ctx.waitForIdle();
  if (!existsSync(REPO_DIR)) {
    ctx.ui.notify(`Missing repo: ${REPO_DIR}`, "error");
    return;
  }

  const commitResult = await commitIfDirty(pi, "manual sync");
  const push = await execGit(pi, ["push"]);
  if (push.code !== 0) {
    ctx.ui.notify((push.stderr || push.stdout || "git push failed").trim(), "error");
    return;
  }

  const parts = [];
  if (commitResult.changed) parts.push(`Committed: ${commitResult.message}`);
  parts.push("Pushed pi-config.");
  ctx.ui.notify(parts.join(" "), "info");
}

async function pullConfig(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
  await ctx.waitForIdle();
  if (!existsSync(REPO_DIR)) {
    ctx.ui.notify(`Missing repo: ${REPO_DIR}`, "error");
    return;
  }

  const status = await getStatus(pi);
  if (status) {
    ctx.ui.notify("Local pi-config changes detected. Commit or stash them before pulling.", "warning");
    return;
  }

  const pull = await execGit(pi, ["pull", "--ff-only"]);
  if (pull.code !== 0) {
    ctx.ui.notify((pull.stderr || pull.stdout || "git pull failed").trim(), "error");
    return;
  }

  ctx.ui.notify((pull.stdout || pull.stderr || "Pulled pi-config.").trim(), "info");
  ctx.ui.notify("Run /reload to refresh Pi resources if needed.", "info");
}

export default function (pi: ExtensionAPI) {
  ensureGlobalConfigLinks();

  pi.registerCommand("pi-config-push", {
    description: "Commit any pi config package changes and push to GitHub",
    handler: async (_args, ctx) => {
      await pushConfig(pi, ctx);
    },
  });

  pi.registerCommand("pi-config-pull", {
    description: "Pull the latest pi config from GitHub using ff-only",
    handler: async (_args, ctx) => {
      await pullConfig(pi, ctx);
    },
  });

  pi.registerCommand("pi-config-status", {
    description: "Show git status for the pi-config package",
    handler: async (_args, ctx) => {
      const status = await getStatus(pi);
      ctx.ui.notify(status || "pi-config clean", "info");
    },
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return;
    if (event.toolName !== "write" && event.toolName !== "edit") return;

    const inputPath = (event.input as { path?: string }).path;
    if (!isTrackedConfigPath(inputPath)) return;

    const result = await commitIfDirty(pi, `${event.toolName} ${inputPath}`);
    if (!result.changed) return;

    ctx.ui.notify(`Auto-committed pi config: ${result.message}`, "info");

    const push = await execGit(pi, ["push"]);
    if (push.code !== 0) {
      ctx.ui.notify((push.stderr || push.stdout || "git push failed").trim(), "error");
      return;
    }

    ctx.ui.notify("Auto-pushed pi config to GitHub.", "info");
  });
}
