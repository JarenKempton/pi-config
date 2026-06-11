import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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
  copyFromPrimary?: string[];
  bootstrapCommands?: string[];
  verifyPaths?: string[];
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
  const primaryPath = primaryWorktreePath(root);
  const configRoots = Array.from(new Set([root, primaryPath]));
  const candidates = configRoots.flatMap((configRoot) => [
    path.join(configRoot, ".pi", "worktrees.json"),
    path.join(configRoot, ".pi", "worktrees.config.json"),
  ]);

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

async function ensureBranchTracksOwnRemote(root: string, branch: string, config: WorktreeConfig) {
  if (!branch || branch === "(detached)" || branch === config.baseBranch) return;

  const ownRemote = remoteRef(config.remote, branch);
  const upstream = upstreamFor(root, branch);
  if (upstream === ownRemote) return;

  if (remoteBranchExists(root, config.remote, branch)) {
    await runAsync("git", ["branch", "--set-upstream-to", ownRemote, branch], root);
    return;
  }

  if (config.pushNewBranches) {
    const pushed = await runAsync("git", ["push", "--set-upstream", config.remote, branch], root);
    if (pushed.ok) return;
  }

  if (upstream) await runAsync("git", ["branch", "--unset-upstream", branch], root);
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

function ticketKeyFrom(input: string): string | undefined {
  return input.match(/[A-Z][A-Z0-9]+-\d+/i)?.[0]?.toUpperCase();
}

function targetFolderNameFor(input: string, branch: string): string {
  return ticketKeyFrom(input) ?? folderNameFor(branch);
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function statusShort(cwd: string): string {
  return run("git", ["status", "--short"], cwd);
}

function worktreesDirFor(mainRepoPath: string, config: WorktreeConfig): string {
  if (!config.worktreesDir) return path.join(path.dirname(mainRepoPath), "worktrees");
  return path.isAbsolute(config.worktreesDir) ? config.worktreesDir : path.resolve(mainRepoPath, config.worktreesDir);
}

function copyConfiguredFiles(sourceRoot: string, targetRoot: string, relativePaths: string[]): string[] {
  const copied: string[] = [];
  for (const relativePath of relativePaths) {
    const from = path.join(sourceRoot, relativePath);
    const to = path.join(targetRoot, relativePath);
    if (!existsSync(from) || existsSync(to)) continue;
    mkdirSync(path.dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true, errorOnExist: true });
    copied.push(relativePath);
  }
  return copied;
}

async function runShellCommand(cwd: string, command: string): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  return runAsync("bash", ["-lc", command], cwd);
}

function clearProgress(ctx: ExtensionContext) {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(WIDGET_ID, undefined);
  ctx.ui.setStatus(WIDGET_ID, undefined);
}

function renderProgress(ctx: ExtensionContext, log: string, steps: ProgressStep[]) {
  if (!ctx.hasUI) return;
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
  const hasBootstrap = Boolean(config.copyFromPrimary?.length || config.bootstrapCommands?.length || config.verifyPaths?.length);
  const steps: ProgressStep[] = [
    { label: "Validate branch and paths", status: "pending" },
    { label: `Fetch ${config.remote} and prune stale refs`, status: "pending" },
    { label: "Create isolated worktree branch", status: "pending" },
    { label: "Set upstream to the matching remote branch", status: "pending" },
    ...(hasBootstrap ? [{ label: "Run project worktree bootstrap", status: "pending" as StepStatus }] : []),
    { label: "Copy worktree path", status: "pending" },
  ];

  mark(steps, 0, "active");
  await showProgress(ctx, "Validating worktree request…", steps);
  if (!branch) {
    fail(ctx, steps, 0, "Provide a branch name, ticket key, PR URL, or other branch-like identifier.");
    return;
  }
  if (!isValidBranchName(root, branch)) {
    fail(ctx, steps, 0, `Invalid git branch name: ${branch}`);
    return;
  }

  const targetBaseDir = worktreesDirFor(primaryPath, config);
  const targetPath = path.join(targetBaseDir, targetFolderNameFor(input, branch));
  if (existsSync(targetPath)) {
    fail(ctx, steps, 0, `Target path already exists: ${targetPath}`);
    return;
  }
  mkdirSync(targetBaseDir, { recursive: true });
  mark(steps, 0, "done");

  mark(steps, 1, "active");
  await showProgress(ctx, `Fetching ${config.remote}…`, steps);
  await runAsync("git", ["fetch", config.remote, "--prune"], root);
  mark(steps, 1, "done");

  mark(steps, 2, "active");
  await showProgress(ctx, `Creating ${branch} in ${targetPath}…`, steps);
  let args: string[];
  if (branchExists(root, branch)) {
    args = ["worktree", "add", targetPath, branch];
  } else if (remoteBranchExists(root, config.remote, branch)) {
    args = ["worktree", "add", "-b", branch, targetPath, remoteRef(config.remote, branch)];
  } else {
    args = ["worktree", "add", "-b", branch, targetPath, remoteRef(config.remote, config.baseBranch)];
  }

  const created = await runAsync("git", args, root);
  if (created.ok === false) {
    fail(ctx, steps, 2, created.error || `Failed to create worktree ${branch}`);
    return;
  }
  mark(steps, 2, "done");

  mark(steps, 3, "active");
  await showProgress(ctx, `Ensuring ${branch} tracks ${remoteRef(config.remote, branch)}…`, steps);
  await ensureBranchTracksOwnRemote(root, branch, config);
  const upstream = upstreamFor(root, branch);
  if (upstream === remoteRef(config.remote, config.baseBranch)) {
    fail(ctx, steps, 3, `Refusing to leave ${branch} tracking ${remoteRef(config.remote, config.baseBranch)}.`);
    return;
  }
  mark(steps, 3, "done");

  let copyPathStepIndex = 4;
  if (hasBootstrap) {
    const bootstrapStepIndex = 4;
    copyPathStepIndex = 5;
    mark(steps, bootstrapStepIndex, "active");
    await showProgress(ctx, "Running project worktree bootstrap…", steps);

    const copied = copyConfiguredFiles(primaryPath, targetPath, config.copyFromPrimary ?? []);
    if (copied.length > 0) await showProgress(ctx, `Copied local files: ${copied.join(", ")}`, steps);

    for (const command of config.bootstrapCommands ?? []) {
      await showProgress(ctx, `Running: ${command}`, steps);
      const result = await runShellCommand(targetPath, command);
      if (!result.ok) {
        fail(ctx, steps, bootstrapStepIndex, result.error || `Bootstrap command failed: ${command}`);
        return;
      }
    }

    const missing = (config.verifyPaths ?? []).filter((relativePath) => !existsSync(path.join(targetPath, relativePath)));
    if (missing.length > 0) {
      fail(ctx, steps, bootstrapStepIndex, `Worktree bootstrap incomplete. Missing: ${missing.join(", ")}`);
      return;
    }

    mark(steps, bootstrapStepIndex, "done");
  }

  mark(steps, copyPathStepIndex, "active");
  await showProgress(ctx, "Copying path to clipboard…", steps);
  const cdCommand = `cd ${shellQuote(targetPath)}`;
  copyPath(cdCommand);
  mark(steps, copyPathStepIndex, "done");
  clearProgress(ctx);
  ctx.ui.notify(cdCommand, "success");
}

function findWorktree(root: string, selected: Worktree | string): Worktree | undefined {
  const list = worktrees(root);
  if (typeof selected !== "string") return selected;
  const sanitized = sanitizeBranchName(selected);
  const ticketKey = ticketKeyFrom(selected);
  return list.find((item) =>
    item.path === selected ||
    item.branch === sanitized ||
    path.basename(item.path) === folderNameFor(sanitized) ||
    Boolean(ticketKey && path.basename(item.path).toUpperCase() === ticketKey),
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
  const summary = status
    ? `${path.basename(wt.path)} has local changes. Delete it and discard those changes?`
    : `Delete ${path.basename(wt.path)}?`;

  const ok = await ctx.ui.confirm("Delete worktree?", summary);
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
  clearProgress(ctx);
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
      const selected = await ctx.ui.select("Git worktrees", [...list.map((wt) => label(wt, currentPath, primaryPath)), create]);
      if (!selected) return;

      if (selected === create) {
        const input = await ctx.ui.input("Branch name, ticket key, or PR URL", "feat/my-change");
        if (input?.trim()) await createWorktree(ctx, input.trim());
        return;
      }

      const wt = list.find((item) => label(item, currentPath, primaryPath) === selected);
      if (!wt) return;

      const action = await ctx.ui.select(`Worktree: ${path.basename(wt.path)}`, ["Copy path", "Delete worktree", "Cancel"]);
      if (action === "Copy path") {
        copyPath(wt.path);
        ctx.ui.notify(`Copied path to clipboard:\n${wt.path}`, "info");
      } else if (action === "Delete worktree") {
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
    if (ctx.hasUI) {
      clearProgress(ctx);
    }
  });
}
