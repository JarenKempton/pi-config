import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

type Worktree = { path: string; branch: string; head?: string; bare?: boolean };
type StepStatus = "pending" | "active" | "done" | "error";
type ProgressStep = { label: string; status: StepStatus };
type WorktreeConfig = {
  baseBranch: string;
  remote: string;
  worktreesDir?: string;
  pushNewBranches: boolean;
  deleteLocalBranches: boolean;
  deleteRemoteBranches: boolean;
};

const WIDGET_ID = "generic-worktrees-progress";
const DEFAULT_CONFIG: WorktreeConfig = {
  baseBranch: process.env.PI_WORKTREE_BASE_BRANCH || "main",
  remote: process.env.PI_WORKTREE_REMOTE || "origin",
  pushNewBranches: process.env.PI_WORKTREE_PUSH_NEW_BRANCHES !== "0",
  deleteLocalBranches: process.env.PI_WORKTREE_DELETE_LOCAL_BRANCHES !== "0",
  deleteRemoteBranches: process.env.PI_WORKTREE_DELETE_REMOTE_BRANCHES === "1",
};

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
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

function runAsync(command: string, args: string[], cwd: string): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ ok: true, stdout: stdout.trimEnd() });
        return;
      }

      resolve({
        ok: false,
        error: [stderr, stdout, error.message].filter(Boolean).join("\n").trim(),
      });
    });
  });
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (current && line === "detached") {
      current.branch = "(detached)";
    } else if (current && line === "bare") {
      current.bare = true;
    }
  }
  if (current) items.push(current);
  return items;
}

function currentWorktreePath(cwd: string): string {
  return repoRoot(cwd);
}

function primaryWorktreePath(cwd: string): string {
  return worktrees(cwd)[0]?.path ?? repoRoot(cwd);
}

function loadConfig(cwd: string): WorktreeConfig {
  const root = repoRoot(cwd);
  const candidates = [
    path.join(root, ".pi", "worktrees.json"),
    path.join(root, ".pi", "worktrees.config.json"),
  ];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const parsed = JSON.parse(readFileSync(candidate, "utf8")) as Partial<WorktreeConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  }

  return DEFAULT_CONFIG;
}

function branchExists(cwd: string, branch: string): boolean {
  return tryRun("git", ["show-ref", "--verify", `refs/heads/${branch}`], cwd).ok;
}

function remoteBranchExists(cwd: string, remote: string, branch: string): boolean {
  return tryRun("git", ["show-ref", "--verify", `refs/remotes/${remote}/${branch}`], cwd).ok;
}

function remoteRef(remote: string, branch: string): string {
  return `${remote}/${branch}`;
}

function upstreamFor(cwd: string, branch: string): string | undefined {
  const result = tryRun("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`], cwd);
  return result.ok && result.stdout.trim() ? result.stdout.trim() : undefined;
}

function ensureBranchTracksOwnRemote(root: string, branch: string, config: WorktreeConfig) {
  if (!branch || branch === "(detached)" || branch === config.baseBranch) return;

  const ownRemote = remoteRef(config.remote, branch);
  const upstream = upstreamFor(root, branch);
  if (upstream === ownRemote) return;

  if (remoteBranchExists(root, config.remote, branch)) {
    tryRun("git", ["branch", "--set-upstream-to", ownRemote, branch], root);
    return;
  }

  if (config.pushNewBranches) {
    const pushed = tryRun("git", ["push", "--set-upstream", config.remote, branch], root);
    if (pushed.ok) return;
  }

  if (upstream) tryRun("git", ["branch", "--unset-upstream", branch], root);
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

function isValidBranchName(cwd: string, branch: string): boolean {
  return tryRun("git", ["check-ref-format", "--branch", branch], cwd).ok;
}

function folderNameFor(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function label(wt: Worktree, currentPath: string, primaryPath: string): string {
  const marker = path.resolve(wt.path) === path.resolve(currentPath)
    ? "current"
    : path.resolve(wt.path) === path.resolve(primaryPath)
      ? "primary"
      : "worktree";
  return `${path.basename(wt.path)} — ${wt.branch} — ${marker} — ${wt.path}`;
}

function copyPath(value: string) {
  spawnSync("pbcopy", { input: value, encoding: "utf8" });
}

function statusShort(cwd: string): string {
  return run("git", ["status", "--short"], cwd);
}

function worktreesDirFor(mainRepoPath: string, config: WorktreeConfig): string {
  if (!config.worktreesDir) return path.join(path.dirname(mainRepoPath), "worktrees");
  return path.isAbsolute(config.worktreesDir) ? config.worktreesDir : path.resolve(mainRepoPath, config.worktreesDir);
}

function renderProgress(ctx: ExtensionContext, log: string, steps: ProgressStep[]) {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(WIDGET_ID, log);
  ctx.ui.setWidget(WIDGET_ID, (_tui, theme) => {
    const icon = (status: StepStatus) => {
      if (status === "done") return theme.fg("success", "✓");
      if (status === "active") return theme.fg("accent", "→");
      if (status === "error") return theme.fg("error", "✗");
      return theme.fg("muted", "○");
    };
    const label = (step: ProgressStep) => {
      if (step.status === "done") return theme.fg("success", step.label);
      if (step.status === "active") return theme.fg("accent", step.label);
      if (step.status === "error") return theme.fg("error", step.label);
      return theme.fg("muted", step.label);
    };
    const logColor = steps.some((step) => step.status === "error")
      ? "error"
      : steps.every((step) => step.status === "done")
        ? "success"
        : "accent";

    return {
      invalidate() {},
      render() {
        return [
          theme.fg(logColor, log),
          "",
          ...steps.map((step) => `${icon(step.status)} ${label(step)}`),
        ];
      },
    };
  });
}

async function showProgress(ctx: ExtensionContext, log: string, steps: ProgressStep[]) {
  renderProgress(ctx, log, steps);
  await nextFrame();
}

function mark(steps: ProgressStep[], index: number, status: StepStatus) {
  steps[index] = { ...steps[index], status };
}

function fail(ctx: ExtensionContext, steps: ProgressStep[], index: number, message: string) {
  mark(steps, index, "error");
  renderProgress(ctx, message, steps);
  ctx.ui.notify(message, "error");
}

async function createWorktree(ctx: ExtensionContext, input: string) {
  const root = repoRoot(ctx.cwd);
  const config = loadConfig(ctx.cwd);
  const primaryPath = primaryWorktreePath(root);
  const branch = sanitizeBranchName(input);
  const steps: ProgressStep[] = [
    { label: "Validate branch and paths", status: "pending" },
    { label: `Fetch ${config.remote} and prune stale refs`, status: "pending" },
    { label: "Create isolated worktree branch", status: "pending" },
    { label: "Set upstream to the matching remote branch", status: "pending" },
    { label: "Copy worktree path", status: "pending" },
  ];

  mark(steps, 0, "active");
  renderProgress(ctx, "Validating worktree request…", steps);
  if (!branch) {
    fail(ctx, steps, 0, "Provide a branch name, ticket key, PR URL, or other branch-like identifier.");
    return;
  }
  if (!isValidBranchName(root, branch)) {
    fail(ctx, steps, 0, `Invalid git branch name: ${branch}`);
    return;
  }

  const targetBaseDir = worktreesDirFor(primaryPath, config);
  const targetPath = path.join(targetBaseDir, folderNameFor(branch));
  if (existsSync(targetPath)) {
    fail(ctx, steps, 0, `Target path already exists: ${targetPath}`);
    return;
  }
  mkdirSync(targetBaseDir, { recursive: true });
  mark(steps, 0, "done");

  mark(steps, 1, "active");
  renderProgress(ctx, `Fetching ${config.remote}…`, steps);
  tryRun("git", ["fetch", config.remote, "--prune"], root);
  mark(steps, 1, "done");

  mark(steps, 2, "active");
  renderProgress(ctx, `Creating ${branch} in ${targetPath}…`, steps);
  let args: string[];
  if (branchExists(root, branch)) {
    args = ["worktree", "add", targetPath, branch];
  } else if (remoteBranchExists(root, config.remote, branch)) {
    args = ["worktree", "add", "-b", branch, targetPath, remoteRef(config.remote, branch)];
  } else {
    args = ["worktree", "add", "-b", branch, targetPath, remoteRef(config.remote, config.baseBranch)];
  }

  const created = tryRun("git", args, root);
  if (created.ok === false) {
    fail(ctx, steps, 2, created.error || `Failed to create worktree ${branch}`);
    return;
  }
  mark(steps, 2, "done");

  mark(steps, 3, "active");
  renderProgress(ctx, `Ensuring ${branch} does not track ${remoteRef(config.remote, config.baseBranch)}…`, steps);
  ensureBranchTracksOwnRemote(root, branch, config);
  const upstream = upstreamFor(root, branch);
  if (upstream === remoteRef(config.remote, config.baseBranch)) {
    fail(ctx, steps, 3, `Refusing to leave ${branch} tracking ${remoteRef(config.remote, config.baseBranch)}.`);
    return;
  }
  mark(steps, 3, "done");

  mark(steps, 4, "active");
  renderProgress(ctx, "Copying path to clipboard…", steps);
  copyPath(targetPath);
  mark(steps, 4, "done");
  renderProgress(ctx, `Worktree ready: ${targetPath}`, steps);
  ctx.ui.notify(`Worktree ready and path copied:\n\ncd ${targetPath}\n\nUpstream: ${upstream ?? "none"}`, "success");
}

function findWorktree(root: string, selected: Worktree | string): Worktree | undefined {
  const list = worktrees(root);
  if (typeof selected !== "string") return selected;
  const sanitized = sanitizeBranchName(selected);
  return list.find((item) =>
    item.path === selected ||
    item.branch === sanitized ||
    path.basename(item.path) === folderNameFor(sanitized),
  );
}

function remoteTrackingRefExists(root: string, config: WorktreeConfig, branch: string): boolean {
  return tryRun("git", ["show-ref", "--verify", `refs/remotes/${config.remote}/${branch}`], root).ok;
}

async function deleteWorktree(ctx: ExtensionContext, selected: Worktree | string) {
  const root = repoRoot(ctx.cwd);
  const config = loadConfig(ctx.cwd);
  const currentPath = currentWorktreePath(ctx.cwd);
  const wt = findWorktree(root, selected);

  if (!wt) {
    ctx.ui.notify(`No matching worktree found for ${String(selected)}`, "warning");
    return;
  }

  if (path.resolve(wt.path) === path.resolve(currentPath)) {
    ctx.ui.notify("Refusing to delete the checkout Pi is currently running in. Open Pi from another worktree first.", "warning");
    return;
  }

  const status = statusShort(wt.path);
  const shouldDeleteBranch = Boolean(config.deleteLocalBranches && wt.branch && wt.branch !== "(detached)" && wt.branch !== config.baseBranch);
  const shouldDeleteRemote = Boolean(shouldDeleteBranch && config.deleteRemoteBranches && remoteBranchExists(root, config.remote, wt.branch));
  const summary = [
    `Remove worktree folder: ${wt.path}`,
    "Prune git worktree metadata",
    shouldDeleteBranch ? `Delete local branch: ${wt.branch}` : undefined,
    shouldDeleteBranch && remoteTrackingRefExists(root, config, wt.branch) ? `Delete local remote-tracking ref: ${remoteRef(config.remote, wt.branch)}` : undefined,
    shouldDeleteRemote ? `Delete remote branch: ${remoteRef(config.remote, wt.branch)}` : undefined,
    status ? `\nLocal changes will be discarded:\n${status}` : undefined,
  ].filter(Boolean).join("\n");

  const ok = await ctx.ui.confirm("Delete worktree and clean local refs?", summary);
  if (!ok) return;

  const steps: ProgressStep[] = [
    { label: "Remove worktree folder", status: "pending" },
    { label: "Prune worktree metadata", status: "pending" },
    { label: "Delete local branch and tracking refs", status: "pending" },
    { label: "Verify cleanup", status: "pending" },
  ];

  mark(steps, 0, "active");
  await showProgress(ctx, `Removing ${wt.path}…`, steps);
  const removed = await runAsync("git", ["worktree", "remove", ...(status ? ["--force"] : []), wt.path], root);
  if (removed.ok === false) {
    fail(ctx, steps, 0, removed.error || `Failed to remove ${wt.path}`);
    return;
  }
  if (existsSync(wt.path)) rmSync(wt.path, { recursive: true, force: true });
  mark(steps, 0, "done");

  mark(steps, 1, "active");
  await showProgress(ctx, "Pruning git worktree metadata…", steps);
  await runAsync("git", ["worktree", "prune"], root);
  mark(steps, 1, "done");

  mark(steps, 2, "active");
  await showProgress(ctx, "Deleting branch refs…", steps);
  let branchNote = "";
  if (shouldDeleteBranch) {
    const deleted = await runAsync("git", ["branch", "-D", wt.branch], root);
    if (deleted.ok) {
      branchNote += `\nDeleted local branch ${wt.branch}.`;
    } else {
      branchNote += `\nLeft local branch ${wt.branch}: ${deleted.error}`;
    }

    if (remoteTrackingRefExists(root, config, wt.branch)) {
      await runAsync("git", ["branch", "-dr", remoteRef(config.remote, wt.branch)], root);
    }
    if (shouldDeleteRemote) {
      const deletedRemote = await runAsync("git", ["push", config.remote, "--delete", wt.branch], root);
      if (deletedRemote.ok) {
        branchNote += `\nDeleted remote branch ${remoteRef(config.remote, wt.branch)}.`;
      } else {
        branchNote += `\nLeft remote branch ${remoteRef(config.remote, wt.branch)}: ${deletedRemote.error}`;
      }
    }
  }
  mark(steps, 2, "done");

  mark(steps, 3, "active");
  await showProgress(ctx, "Verifying cleanup…", steps);
  const stillListed = worktrees(root).some((item) => path.resolve(item.path) === path.resolve(wt.path));
  if (stillListed || existsSync(wt.path)) {
    fail(ctx, steps, 3, `Cleanup incomplete for ${wt.path}`);
    return;
  }
  mark(steps, 3, "done");
  renderProgress(ctx, `Removed worktree: ${wt.path}`, steps);
  ctx.ui.notify(`Removed worktree:\n${wt.path}${branchNote}`, "success");
}

export default function genericWorktrees(pi: ExtensionAPI) {
  pi.registerCommand("worktrees", {
    description: "Select, copy path, delete, or create a git worktree in ../worktrees",
    handler: async (_args, ctx) => {
      let root: string;
      let list: Worktree[];
      let currentPath: string;
      let primaryPath: string;
      try {
        root = repoRoot(ctx.cwd);
        list = worktrees(root);
        currentPath = currentWorktreePath(ctx.cwd);
        primaryPath = primaryWorktreePath(root);
      } catch (error) {
        ctx.ui.notify(`Unable to list worktrees: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }

      const create = "＋ Create worktree";
      const copyPrefix = "📋 Copy path — ";
      const deletePrefix = "🗑 Delete — ";
      const options = [
        create,
        ...list.flatMap((wt) => {
          const itemLabel = label(wt, currentPath, primaryPath);
          return [`${copyPrefix}${itemLabel}`, `${deletePrefix}${itemLabel}`];
        }),
      ];
      const selected = await ctx.ui.select("Git worktrees", options);
      if (!selected) return;

      if (selected === create) {
        const input = await ctx.ui.input("Branch name, ticket key, or PR URL", "feat/my-change");
        if (input?.trim()) await createWorktree(ctx, input.trim());
        return;
      }

      const selectedLabel = selected.startsWith(copyPrefix)
        ? selected.slice(copyPrefix.length)
        : selected.startsWith(deletePrefix)
          ? selected.slice(deletePrefix.length)
          : "";
      const wt = list.find((item) => label(item, currentPath, primaryPath) === selectedLabel);
      if (!wt) return;

      if (selected.startsWith(copyPrefix)) {
        copyPath(wt.path);
        ctx.ui.notify(`Copied path to clipboard:\n${wt.path}`, "info");
      } else if (selected.startsWith(deletePrefix)) {
        await deleteWorktree(ctx, wt);
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
      if (input) await deleteWorktree(ctx, input);
    },
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET_ID, undefined);
  });
}
