import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const DEFAULT_BASE_BRANCH = process.env.PI_WORKTREE_BASE_BRANCH || "main";
const SALES_AI_MAIN = path.join(process.env.HOME || "/Users/jaren", "Documents/programming/salesai");
const SALES_AI_WORKTREES = path.join(process.env.HOME || "/Users/jaren", "Documents/programming/salesai-worktrees");
const SALES_AI_WORKTREE_SCRIPT = path.join(process.env.HOME || "/Users/jaren", ".pi/agent/bin/salesai-worktree.sh");

type Worktree = { path: string; branch: string; head?: string; bare?: boolean };
type JiraInfo = { key: string; summary?: string; issueType?: string };

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryRun(command: string, args: string[], cwd: string): { ok: true; stdout: string } | { ok: false; error: string } {
  try {
    return { ok: true, stdout: run(command, args, cwd) };
  } catch (error) {
    const anyError = error as { stderr?: Buffer; stdout?: Buffer; message?: string };
    return {
      ok: false,
      error: [anyError.stderr?.toString(), anyError.stdout?.toString(), anyError.message].filter(Boolean).join("\n").trim(),
    };
  }
}

function repoRoot(cwd: string): string {
  return run("git", ["rev-parse", "--show-toplevel"], cwd);
}

function mainRepoRoot(cwd: string): string {
  const root = repoRoot(cwd);
  const commonDirRaw = run("git", ["rev-parse", "--git-common-dir"], cwd);
  const commonDir = path.isAbsolute(commonDirRaw) ? commonDirRaw : path.resolve(root, commonDirRaw);
  return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : root;
}

function worktrees(cwd: string): Worktree[] {
  const raw = run("git", ["worktree", "list", "--porcelain"], cwd);
  const items: Worktree[] = [];
  let current: Worktree | null = null;

  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) items.push(current);
      current = { path: line.slice("worktree ".length), branch: "(unknown)" };
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch refs/heads/".length);
    } else if (current && line === "detached") {
      current.branch = "(detached)";
    } else if (current && line === "bare") {
      current.bare = true;
    }
  }
  if (current) items.push(current);
  return items;
}

function branchExists(cwd: string, branch: string): boolean {
  return tryRun("git", ["show-ref", "--verify", `refs/heads/${branch}`], cwd).ok;
}

function remoteBranchExists(cwd: string, branch: string): boolean {
  return tryRun("git", ["show-ref", "--verify", `refs/remotes/origin/${branch}`], cwd).ok;
}

function sanitizeBranchName(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/^.*\/pull\/(\d+).*$/, "pr-$1")
    .replace(/^refs\/heads\//, "")
    .replace(/^origin\//, "")
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function folderNameFor(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function extractTicketKey(input: string): string | null {
  return input.match(/\b[A-Z][A-Z0-9]+-\d+\b/i)?.[0].toUpperCase() ?? null;
}

function kebab(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 8)
    .join("-");
}

function fetchJiraInfo(root: string, key: string): JiraInfo {
  const result = tryRun("acli", ["jira", "workitem", "view", key, "--fields", "summary,issuetype", "--json"], root);
  if (!result.ok) return { key };

  try {
    const parsed = JSON.parse(result.stdout) as { fields?: { summary?: string; issuetype?: { name?: string } } };
    return { key, summary: parsed.fields?.summary, issueType: parsed.fields?.issuetype?.name };
  } catch {
    return { key };
  }
}

function isSalesAiRepo(mainRoot: string): boolean {
  return path.resolve(mainRoot) === path.resolve(SALES_AI_MAIN) || path.basename(mainRoot) === "salesai";
}

function salesAiBranchFor(info: JiraInfo): string {
  const type = info.issueType?.toLowerCase() === "bug" ? "fix" : "feat";
  const slug = info.summary ? kebab(info.summary) : "work";
  return `${type}/${info.key}-${slug}`;
}

function label(wt: Worktree, mainPath: string): string {
  const marker = path.resolve(wt.path) === path.resolve(mainPath) ? "main" : "worktree";
  return `${path.basename(wt.path)} — ${wt.branch} — ${marker} — ${wt.path}`;
}

function copyPath(value: string) {
  spawnSync("pbcopy", { input: value, encoding: "utf8" });
}

function statusShort(cwd: string): string {
  return run("git", ["status", "--short"], cwd);
}

function worktreesDirFor(mainRepoPath: string): string {
  return isSalesAiRepo(mainRepoPath) ? SALES_AI_WORKTREES : path.join(path.dirname(mainRepoPath), "worktrees");
}

function copyIfPresent(sourceRoot: string, targetRoot: string, relativePath: string): string | null {
  const source = path.join(sourceRoot, relativePath);
  const target = path.join(targetRoot, relativePath);
  if (!existsSync(source) || existsSync(target)) return null;
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
  return relativePath;
}

function runStep(command: string, args: string[], cwd: string): { ok: boolean; output: string } {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { ok: result.status === 0, output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim() };
}

function hydrateSalesAiWorktree(sourceRoot: string, targetPath: string): string[] {
  const copied: string[] = [];
  for (const relativePath of [".pi", "frontend/.pi", "frontend/.env.local", "frontend/.env.harness.local", "frontend/.env.dev"]) {
    const copiedPath = copyIfPresent(sourceRoot, targetPath, relativePath);
    if (copiedPath) copied.push(copiedPath);
  }
  return copied;
}

async function createWorktree(ctx: any, input: string) {
  const sourceRoot = repoRoot(ctx.cwd);
  const mainRoot = mainRepoRoot(ctx.cwd);
  const ticketKey = extractTicketKey(input);
  const salesAi = isSalesAiRepo(mainRoot) && ticketKey;
  if (salesAi) {
    ctx.ui.notify("Launching deterministic SalesAI worktree CLI…", "info");
    const result = spawnSync("bash", [SALES_AI_WORKTREE_SCRIPT, "create", input], {
      cwd: mainRoot,
      stdio: "inherit",
      env: process.env,
    });
    if (result.status !== 0) {
      ctx.ui.notify(`SalesAI worktree setup failed with exit code ${result.status ?? "unknown"}.`, "error");
    }
    return;
  }

  const branch = sanitizeBranchName(input);

  if (!branch) {
    ctx.ui.notify("Provide a branch name, ticket key, PR URL, or other branch-like identifier.", "warning");
    return;
  }

  const targetBaseDir = worktreesDirFor(mainRoot);
  const targetPath = salesAi && ticketKey ? path.join(targetBaseDir, ticketKey) : path.join(targetBaseDir, folderNameFor(branch));

  if (existsSync(targetPath)) {
    ctx.ui.notify(`Target worktree path already exists; refusing to overwrite:\n${targetPath}`, "warning");
    return;
  }

  mkdirSync(targetBaseDir, { recursive: true });

  ctx.ui.notify(`Preparing worktree ${branch} from ${DEFAULT_BASE_BRANCH} at ${targetPath}…`, "info");
  tryRun("git", ["fetch", "origin", "--prune"], mainRoot);

  let args: string[];
  if (branchExists(mainRoot, branch)) {
    args = ["worktree", "add", targetPath, branch];
  } else if (remoteBranchExists(mainRoot, branch)) {
    args = ["worktree", "add", "-b", branch, targetPath, `origin/${branch}`];
  } else {
    args = ["worktree", "add", "-b", branch, targetPath, `origin/${DEFAULT_BASE_BRANCH}`];
  }

  const result = tryRun("git", args, mainRoot);
  if (!result.ok) {
    ctx.ui.notify(result.error || `Failed to create worktree ${branch}`, "error");
    return;
  }

  tryRun("git", ["-C", targetPath, "branch", "--unset-upstream"], mainRoot);

  const registered = worktrees(mainRoot).some((wt) => path.resolve(wt.path) === path.resolve(targetPath));
  if (!registered) {
    ctx.ui.notify(`Worktree was created but is not registered where expected:\n${targetPath}`, "error");
    return;
  }

  let copied: string[] = [];
  if (salesAi) {
    copied = hydrateSalesAiWorktree(sourceRoot, targetPath);

    ctx.ui.notify("Running npm install…", "info");
    const npmInstall = runStep("npm", ["install"], targetPath);
    if (!npmInstall.ok) {
      ctx.ui.notify(`Worktree created, but npm install failed:\n${targetPath}\n\n${npmInstall.output}`, "error");
      return;
    }

    const packageLockStatus = tryRun("git", ["-C", targetPath, "status", "--short", "--", "package-lock.json"], mainRoot);
    if (packageLockStatus.ok && packageLockStatus.stdout.trim()) {
      tryRun("git", ["-C", targetPath, "restore", "package-lock.json"], mainRoot);
    }

    ctx.ui.notify("Running npm run dev:api-client…", "info");
    const apiClient = runStep("npm", ["run", "dev:api-client"], targetPath);
    if (!apiClient.ok) {
      ctx.ui.notify(`Worktree created, but API client generation failed:\n${targetPath}\n\n${apiClient.output}`, "error");
      return;
    }

    const ready = existsSync(path.join(targetPath, "node_modules")) && existsSync(path.join(targetPath, ".nx/nxw.js"));
    if (!ready) {
      ctx.ui.notify(`Worktree setup finished but readiness checks failed:\n${targetPath}`, "error");
      return;
    }
  }

  copyPath(targetPath);
  const copiedNote = copied.length ? `\nCopied local files: ${copied.join(", ")}` : "";
  ctx.ui.notify(`Worktree ready and path copied:\n\ncd ${targetPath}${copiedNote}`, "success");
}

async function deleteWorktree(ctx: any, selected: Worktree | string) {
  const root = mainRepoRoot(ctx.cwd);
  const list = worktrees(root);
  const raw = typeof selected === "string" ? selected.trim() : "";
  const ticketKey = raw ? extractTicketKey(raw) : null;
  const wt = typeof selected === "string"
    ? list.find((item) =>
        item.path === raw ||
        item.branch === sanitizeBranchName(raw) ||
        path.basename(item.path).toLowerCase() === folderNameFor(sanitizeBranchName(raw)).toLowerCase() ||
        (ticketKey && path.basename(item.path).toUpperCase() === ticketKey)
      )
    : selected;

  if (!wt) {
    ctx.ui.notify(`No matching registered worktree found for ${String(selected)}`, "warning");
    return;
  }

  if (path.resolve(wt.path) === path.resolve(root)) {
    ctx.ui.notify("Refusing to delete the current/main checkout.", "warning");
    return;
  }

  const status = statusShort(wt.path);
  if (status) {
    const force = await ctx.ui.confirm("Worktree has local changes. Force remove?", `${wt.path}\n\n${status}`);
    if (!force) return;
  }

  const removeArgs = ["worktree", "remove", ...(status ? ["--force"] : []), wt.path];
  const removed = tryRun("git", removeArgs, root);
  if (!removed.ok) {
    ctx.ui.notify(removed.error || `Failed to remove ${wt.path}`, "error");
    return;
  }

  tryRun("git", ["worktree", "prune"], root);

  let branchNote = "";
  if (wt.branch && wt.branch !== "(detached)" && wt.branch !== DEFAULT_BASE_BRANCH) {
    const deleteBranch = await ctx.ui.confirm("Delete local branch too?", wt.branch);
    if (deleteBranch) {
      const deleted = tryRun("git", ["branch", "-D", wt.branch], root);
      branchNote = deleted.ok ? `\nDeleted branch ${wt.branch}.` : `\nLeft branch ${wt.branch}: ${deleted.error}`;
    }
  }

  ctx.ui.notify(`Removed worktree:\n${wt.path}${branchNote}`, "success");
}

export default function genericWorktrees(pi: ExtensionAPI) {
  pi.registerCommand("worktrees", {
    description: "Select, copy path, delete, or create a git worktree",
    handler: async (_args, ctx) => {
      let root: string;
      let list: Worktree[];
      try {
        root = mainRepoRoot(ctx.cwd);
        list = worktrees(root);
      } catch (error) {
        ctx.ui.notify(`Unable to list worktrees: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }

      const create = "＋ Create worktree";
      const selected = await ctx.ui.select("Git worktrees", [...list.map((wt) => label(wt, root)), create]);
      if (!selected) return;

      if (selected === create) {
        const input = await ctx.ui.input("Branch name, ticket key, Jira URL, or PR URL", "CSU-1234");
        if (input?.trim()) await createWorktree(ctx, input.trim());
        return;
      }

      const wt = list.find((item) => label(item, root) === selected);
      if (!wt) return;

      const action = await ctx.ui.select(`Worktree: ${path.basename(wt.path)}`, ["Copy path", "Delete worktree", "Cancel"]);
      if (action === "Copy path") {
        copyPath(wt.path);
        ctx.ui.notify(`Copied path to clipboard:\n${wt.path}`, "info");
      } else if (action === "Delete worktree") {
        const ok = await ctx.ui.confirm("Delete worktree?", wt.path);
        if (ok) await deleteWorktree(ctx, wt);
      }
    },
  });

  pi.registerCommand("create-worktree", {
    description: "Create a git worktree from a branch name, ticket key, Jira URL, or PR URL",
    handler: async (args, ctx) => {
      const input = args.trim() || (await ctx.ui.input("Branch name, ticket key, Jira URL, or PR URL", "CSU-1234"))?.trim();
      if (input) await createWorktree(ctx, input);
    },
  });

  pi.registerCommand("delete-worktree", {
    description: "Delete a git worktree by path, branch name, ticket key, or worktree folder name",
    handler: async (args, ctx) => {
      const input = args.trim() || (await ctx.ui.input("Worktree path, branch name, ticket key, or folder name", "CSU-1234"))?.trim();
      if (!input) return;
      const ok = await ctx.ui.confirm("Delete matching worktree?", input);
      if (ok) await deleteWorktree(ctx, input);
    },
  });
}
