import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

const DEFAULT_BASE_BRANCH = process.env.PI_WORKTREE_BASE_BRANCH || "main";

type Worktree = { path: string; branch: string; head?: string; bare?: boolean };

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
  return path.join(path.dirname(mainRepoPath), "worktrees");
}

async function createWorktree(ctx: any, input: string) {
  const root = repoRoot(ctx.cwd);
  const branch = sanitizeBranchName(input);
  if (!branch) {
    ctx.ui.notify("Provide a branch name, ticket key, PR URL, or other branch-like identifier.", "warning");
    return;
  }

  const targetBaseDir = worktreesDirFor(root);
  const targetPath = path.join(targetBaseDir, folderNameFor(branch));
  mkdirSync(targetBaseDir, { recursive: true });

  ctx.ui.notify(`Preparing worktree ${branch} from ${DEFAULT_BASE_BRANCH}…`, "info");
  tryRun("git", ["fetch", "origin", "--prune"], root);

  let args: string[];
  if (branchExists(root, branch)) {
    args = ["worktree", "add", targetPath, branch];
  } else if (remoteBranchExists(root, branch)) {
    args = ["worktree", "add", "-b", branch, targetPath, `origin/${branch}`];
  } else {
    args = ["worktree", "add", "-b", branch, targetPath, `origin/${DEFAULT_BASE_BRANCH}`];
  }

  const result = tryRun("git", args, root);
  if (!result.ok) {
    ctx.ui.notify(result.error || `Failed to create worktree ${branch}`, "error");
    return;
  }

  copyPath(targetPath);
  ctx.ui.notify(`Worktree ready and path copied:\n\ncd ${targetPath}`, "success");
}

async function deleteWorktree(ctx: any, selected: Worktree | string) {
  const root = repoRoot(ctx.cwd);
  const list = worktrees(root);
  const wt = typeof selected === "string"
    ? list.find((item) => item.path === selected || item.branch === sanitizeBranchName(selected) || path.basename(item.path) === folderNameFor(sanitizeBranchName(selected)))
    : selected;

  if (!wt) {
    ctx.ui.notify(`No matching worktree found for ${String(selected)}`, "warning");
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
    description: "Select, copy path, delete, or create a git worktree in ../worktrees",
    handler: async (_args, ctx) => {
      let root: string;
      let list: Worktree[];
      try {
        root = repoRoot(ctx.cwd);
        list = worktrees(root);
      } catch (error) {
        ctx.ui.notify(`Unable to list worktrees: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }

      const create = "＋ Create worktree";
      const selected = await ctx.ui.select("Git worktrees", [...list.map((wt) => label(wt, root)), create]);
      if (!selected) return;

      if (selected === create) {
        const input = await ctx.ui.input("Branch name, ticket key, or PR URL", "feat/my-change");
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
    description: "Create a git worktree in ../worktrees from a branch name, ticket key, or PR URL",
    handler: async (args, ctx) => {
      const input = args.trim() || (await ctx.ui.input("Branch name, ticket key, or PR URL", "feat/my-change"))?.trim();
      if (input) await createWorktree(ctx, input);
    },
  });

  pi.registerCommand("delete-worktree", {
    description: "Delete a git worktree by path, branch name, or worktree folder name",
    handler: async (args, ctx) => {
      const input = args.trim() || (await ctx.ui.input("Worktree path, branch name, or folder name", "feat/my-change"))?.trim();
      if (!input) return;
      const ok = await ctx.ui.confirm("Delete matching worktree?", input);
      if (ok) await deleteWorktree(ctx, input);
    },
  });
}
