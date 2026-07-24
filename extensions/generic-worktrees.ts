import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
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
  verifyCommands?: string[];
  ticket?: {
    branchTemplate?: string;
    pathTemplate?: string;
  };
};

type WorktreeCreateInput = {
  branch?: string;
  ticket_key?: string;
  ticket_title?: string;
  change_type?: string;
  input?: string;
};

type WorktreeCreateResult = {
  ok: boolean;
  path?: string;
  branch?: string;
  status: string;
  copied?: string[];
  upstream?: string;
  error?: string;
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

function commandError(result: { ok: true; stdout: string } | { ok: false; error: string }) {
  return "error" in result ? result.error : "";
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

export function loadConfig(cwd: string): WorktreeConfig {
  const root = repoRoot(cwd);
  const primaryPath = primaryWorktreePath(root);
  const configRoots = Array.from(new Set([primaryPath, root]));
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

function commandExists(command: string): boolean {
  return spawnSync("bash", ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`]).status === 0;
}

function jiraIssueText(cwd: string, ticketKey: string): string | undefined {
  const commands = [
    ["acli", ["jira", "workitem", "view", ticketKey]],
    ["acli", ["jira", "issue", "view", ticketKey]],
    ["jira", ["issue", "view", ticketKey]],
  ] as const;

  for (const [command, args] of commands) {
    if (!commandExists(command)) continue;
    const result = tryRun(command, [...args], cwd);
    if (result.ok && result.stdout.trim()) return result.stdout;
  }

  return undefined;
}

function jiraIssueType(cwd: string, ticketKey: string): string | undefined {
  const text = jiraIssueText(cwd, ticketKey);
  if (!text) return undefined;

  const issueTypeLine = text
    .split("\n")
    .find((line) => /(^|\b)(type|issue type)\s*:/i.test(line));
  if (!issueTypeLine) return undefined;

  return issueTypeLine.replace(/^.*?(type|issue type)\s*:\s*/i, "").trim();
}

function changeTypeSlug(input: string | undefined): string {
  const value = (input ?? "").trim().toLowerCase();
  if (/^(fix|bug|bugfix|hotfix)$/.test(value)) return "fix";
  if (/^(chore|docs|test|refactor|perf|style)$/.test(value)) return value;
  return "feat";
}

function branchTypeForTicket(cwd: string, ticketKey: string, changeType?: string): string {
  if (changeType) return changeTypeSlug(changeType);
  const issueType = jiraIssueType(cwd, ticketKey);
  return issueType && /\bbug\b/i.test(issueType) ? "fix" : "feat";
}

function slugify(input: string | undefined): string {
  return (input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function applyTicketTemplate(template: string, values: { type: string; key: string; slug: string }): string {
  return template
    .replace(/\{type\}/g, values.type)
    .replace(/\{key\}/g, values.key)
    .replace(/\{slug\}/g, values.slug)
    .replace(/-+(?=\/|$)/g, "")
    .replace(/\/+/g, "/")
    .replace(/^\/|\/$/g, "");
}

export function branchNameForCreateInput(cwd: string, config: WorktreeConfig, request: WorktreeCreateInput): string {
  const explicitBranch = (request.branch ?? "").trim();
  if (explicitBranch) return sanitizeBranchName(explicitBranch);

  const rawInput = (request.input ?? "").trim();
  const ticketKey = (request.ticket_key ?? ticketKeyFrom(rawInput) ?? "").toUpperCase();
  if (ticketKey) {
    const type = branchTypeForTicket(cwd, ticketKey, request.change_type);
    const slug = slugify(request.ticket_title);
    return applyTicketTemplate(config.ticket?.branchTemplate ?? "{type}/{key}-{slug}", { type, key: ticketKey, slug });
  }

  return sanitizeBranchName(rawInput);
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

export function targetFolderNameForCreateInput(config: WorktreeConfig, request: WorktreeCreateInput, branch: string): string {
  const rawInput = (request.input ?? "").trim();
  const ticketKey = (request.ticket_key ?? ticketKeyFrom(rawInput) ?? "").toUpperCase();
  if (ticketKey) {
    return applyTicketTemplate(config.ticket?.pathTemplate ?? "{key}", {
      type: changeTypeSlug(request.change_type),
      key: ticketKey,
      slug: slugify(request.ticket_title),
    });
  }
  return folderNameFor(branch);
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

export function worktreesDirFor(mainRepoPath: string, config: WorktreeConfig): string {
  if (!config.worktreesDir) return path.join(path.dirname(mainRepoPath), "worktrees");
  return path.isAbsolute(config.worktreesDir) ? config.worktreesDir : path.resolve(mainRepoPath, config.worktreesDir);
}

function assertSafeRelativePath(relativePath: string, label: string) {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]+/).includes("..")) {
    throw new Error(`Unsafe ${label} path: ${relativePath}`);
  }
}

function resolveChildPath(parent: string, childName: string): string {
  assertSafeRelativePath(childName, "worktree target");
  const resolved = path.resolve(parent, childName);
  const relative = path.relative(path.resolve(parent), resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Unsafe worktree target path: ${childName}`);
  }
  return resolved;
}

function copyConfiguredFiles(sourceRoot: string, targetRoot: string, relativePaths: string[]): string[] {
  const copied: string[] = [];
  for (const relativePath of relativePaths) {
    assertSafeRelativePath(relativePath, "copyFromPrimary");
    const from = path.join(sourceRoot, relativePath);
    const to = path.join(targetRoot, relativePath);
    if (!existsSync(from) || existsSync(to)) continue;
    mkdirSync(path.dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true, errorOnExist: true });
    copied.push(relativePath);
  }
  return copied;
}

function readJsonFile<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

type PackageJson = {
  workspaces?: string[] | { packages?: string[] };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function workspaceGlobs(pkg: PackageJson | undefined): string[] {
  if (!pkg?.workspaces) return [];
  return Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages ?? [];
}

function workspacePackageDirs(root: string): string[] {
  const pkg = readJsonFile<PackageJson>(path.join(root, "package.json"));
  return workspaceGlobs(pkg)
    .filter((glob) => !glob.includes("*"))
    .filter((relativePath) => existsSync(path.join(root, relativePath, "package.json")));
}

function workspaceUsesDependency(root: string, workspaceDir: string, dependency: string): boolean {
  const pkg = readJsonFile<PackageJson>(path.join(root, workspaceDir, "package.json"));
  return Boolean(pkg?.dependencies?.[dependency] || pkg?.devDependencies?.[dependency]);
}

function normalizeBootstrapCommand(cwd: string, command: string): string {
  if (command.trim() !== "npm install") return command;
  const pkg = readJsonFile<PackageJson>(path.join(cwd, "package.json"));
  if (workspaceGlobs(pkg).length === 0) return command;
  return "npm install --workspaces --include-workspace-root";
}

function implicitVerifyCommands(root: string): string[] {
  const commands: string[] = [];
  for (const workspaceDir of workspacePackageDirs(root)) {
    if (workspaceUsesDependency(root, workspaceDir, "next")) {
      commands.push(`cd ${shellQuote(workspaceDir)} && npm exec next -- --version`);
    }
  }
  return commands;
}

async function runShellCommand(cwd: string, command: string): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const output: string[] = [];
    const append = (chunk: Buffer) => {
      const text = chunk.toString();
      output.push(text);
      if (output.join("").length > 12000) output.splice(0, output.length - 1);
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => resolve({ ok: false, error: error.message }));
    child.on("close", (code) => {
      const text = output.join("").trim();
      if (code === 0) {
        resolve({ ok: true, stdout: text });
      } else {
        resolve({ ok: false, error: text || `Command exited with status ${code}: ${command}` });
      }
    });
  });
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

export async function createWorktreeService(cwd: string, request: WorktreeCreateInput, onStatus?: (status: string) => Promise<void> | void): Promise<WorktreeCreateResult> {
  const root = repoRoot(cwd);
  const config = loadConfig(cwd);
  const primaryPath = primaryWorktreePath(root);
  const branch = branchNameForCreateInput(root, config, request);

  const status = async (message: string) => {
    if (onStatus) await onStatus(message);
  };

  if (!branch) return { ok: false, status: "error", error: "Provide a branch name, ticket key, PR URL, or other branch-like identifier." };
  if (!isValidBranchName(root, branch)) return { ok: false, branch, status: "error", error: `Invalid git branch name: ${branch}` };

  const targetBaseDir = worktreesDirFor(primaryPath, config);
  let targetPath: string;
  try {
    targetPath = resolveChildPath(targetBaseDir, targetFolderNameForCreateInput(config, request, branch));
  } catch (error) {
    return { ok: false, branch, status: "error", error: error instanceof Error ? error.message : String(error) };
  }

  try {
    for (const relativePath of config.copyFromPrimary ?? []) assertSafeRelativePath(relativePath, "copyFromPrimary");
    for (const relativePath of config.verifyPaths ?? []) assertSafeRelativePath(relativePath, "verifyPaths");
  } catch (error) {
    return { ok: false, branch, path: targetPath, status: "unsafe-config", error: error instanceof Error ? error.message : String(error) };
  }

  const existingCheckout = worktrees(root).find((item) => item.branch === branch);
  if (existingCheckout) {
    return { ok: false, branch, path: existingCheckout.path, status: "collision", error: `Branch ${branch} is already checked out at ${existingCheckout.path}` };
  }
  if (existsSync(targetPath)) {
    return { ok: false, branch, path: targetPath, status: "collision", error: `Target path already exists: ${targetPath}` };
  }

  mkdirSync(targetBaseDir, { recursive: true });

  await status(`Fetching ${config.remote} and pruning stale refs…`);
  const fetched = await runAsync("git", ["fetch", config.remote, "--prune"], root);
  if (!fetched.ok) return { ok: false, branch, path: targetPath, status: "fetch-failed", error: commandError(fetched) };

  await status(`Creating ${branch} in ${targetPath}…`);
  let args: string[];
  if (branchExists(root, branch)) {
    args = ["worktree", "add", targetPath, branch];
  } else if (remoteBranchExists(root, config.remote, branch)) {
    args = ["worktree", "add", "-b", branch, targetPath, remoteRef(config.remote, branch)];
  } else {
    args = ["worktree", "add", "-b", branch, targetPath, remoteRef(config.remote, config.baseBranch)];
  }

  const created = await runAsync("git", args, root);
  if (!created.ok) return { ok: false, branch, path: targetPath, status: "create-failed", error: commandError(created) || `Failed to create worktree ${branch}` };

  await status(`Applying upstream configuration for ${branch}…`);
  await ensureBranchTracksOwnRemote(root, branch, config);
  const upstream = upstreamFor(root, branch);
  if (upstream === remoteRef(config.remote, config.baseBranch)) {
    return { ok: false, branch, path: targetPath, upstream, status: "unsafe-upstream", error: `Refusing to leave ${branch} tracking ${remoteRef(config.remote, config.baseBranch)}.` };
  }

  const copied = copyConfiguredFiles(primaryPath, targetPath, config.copyFromPrimary ?? []);
  for (const configuredCommand of config.bootstrapCommands ?? []) {
    const command = normalizeBootstrapCommand(targetPath, configuredCommand);
    await status(`Running bootstrap command: ${command}`);
    const result = await runShellCommand(targetPath, command);
    if (!result.ok) return { ok: false, branch, path: targetPath, upstream, copied, status: "bootstrap-failed", error: commandError(result) || `Bootstrap command failed: ${command}` };
  }

  const verifyPaths = [...(config.verifyPaths ?? [])];
  if (existsSync(path.join(targetPath, "package.json")) && existsSync(path.join(targetPath, "nx.json"))) {
    verifyPaths.push("node_modules/.bin/nx");
  }

  const missing = Array.from(new Set(verifyPaths)).filter((relativePath) => !existsSync(path.join(targetPath, relativePath)));
  if (missing.length > 0) {
    return { ok: false, branch, path: targetPath, upstream, copied, status: "verify-failed", error: `Worktree bootstrap incomplete. Missing: ${missing.join(", ")}` };
  }

  const verifyCommands = Array.from(new Set([...(config.verifyCommands ?? []), ...implicitVerifyCommands(targetPath)]));
  for (const command of verifyCommands) {
    await status(`Running verification command: ${command}`);
    const result = await runShellCommand(targetPath, command);
    if (!result.ok) return { ok: false, branch, path: targetPath, upstream, copied, status: "verify-failed", error: commandError(result) || `Verification command failed: ${command}` };
  }

  return { ok: true, branch, path: targetPath, upstream, copied, status: `created ${branch} at ${targetPath}` };
}

async function createWorktree(_pi: ExtensionAPI, ctx: ExtensionContext, input: string) {
  const root = repoRoot(ctx.cwd);
  const config = loadConfig(ctx.cwd);
  const hasBootstrap = Boolean(
    config.copyFromPrimary?.length ||
    config.bootstrapCommands?.length ||
    config.verifyPaths?.length ||
    config.verifyCommands?.length,
  );
  const steps: ProgressStep[] = [
    { label: "Validate branch and paths", status: "pending" },
    { label: `Fetch ${config.remote} and prune stale refs`, status: "pending" },
    { label: "Create isolated worktree branch", status: "pending" },
    { label: "Apply configured upstream behavior", status: "pending" },
    ...(hasBootstrap ? [{ label: "Run project worktree bootstrap", status: "pending" as StepStatus }] : []),
    { label: "Copy worktree path", status: "pending" },
  ];

  let statusIndex = 0;
  mark(steps, statusIndex, "active");
  const advance = async (message: string) => {
    if (/^Fetching /.test(message)) {
      mark(steps, statusIndex, "done");
      statusIndex = 1;
      mark(steps, statusIndex, "active");
    } else if (/^Creating /.test(message)) {
      mark(steps, statusIndex, "done");
      statusIndex = 2;
      mark(steps, statusIndex, "active");
    } else if (/^Applying upstream /.test(message)) {
      mark(steps, statusIndex, "done");
      statusIndex = 3;
      mark(steps, statusIndex, "active");
    } else if (/^(Running bootstrap|Running verification)/.test(message) && hasBootstrap) {
      mark(steps, statusIndex, "done");
      statusIndex = 4;
      mark(steps, statusIndex, "active");
    }
    await showProgress(ctx, message, steps);
  };

  await showProgress(ctx, "Validating worktree request…", steps);
  const result = await createWorktreeService(ctx.cwd, { input }, advance);
  if (!result.ok || !result.path) {
    fail(ctx, steps, statusIndex, result.error ?? result.status);
    return;
  }

  mark(steps, statusIndex, "done");
  const copyPathStepIndex = steps.length - 1;
  mark(steps, copyPathStepIndex, "active");
  await showProgress(ctx, "Copying path to clipboard…", steps);
  const cdCommand = `cd ${shellQuote(result.path)}`;
  copyPath(cdCommand);
  mark(steps, copyPathStepIndex, "done");
  clearProgress(ctx);
  ctx.ui.notify(`${cdCommand}\n${result.status}`, "info");
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
    fail(ctx, steps, 0, commandError(removed) || `Failed to remove ${wt.path}`);
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
      branchNote += `\nLeft local branch ${wt.branch}: ${commandError(deleted)}`;
    }

    if (remoteTrackingRefExists(root, config, wt.branch)) {
      await runAsync("git", ["branch", "-dr", remoteRef(config.remote, wt.branch)], root);
    }
    if (shouldDeleteRemote) {
      const deletedRemote = await runAsync("git", ["push", config.remote, "--delete", wt.branch], root);
      if (deletedRemote.ok) {
        branchNote += `\nDeleted remote branch ${remoteRef(config.remote, wt.branch)}.`;
      } else {
        branchNote += `\nLeft remote branch ${remoteRef(config.remote, wt.branch)}: ${commandError(deletedRemote)}`;
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
  ctx.ui.notify(`Removed worktree:\n${wt.path}${branchNote}`, "info");
}

export default function genericWorktrees(pi: ExtensionAPI) {
  pi.registerTool({
    name: "worktree_create",
    label: "Create Worktree",
    description:
      "Create a git worktree using this repository's .pi/worktrees.json. Provide either explicit branch or ticket_key plus optional ticket_title/change_type. Does not invoke ticket planning.",
    parameters: Type.Object({
      branch: Type.Optional(Type.String({ description: "Explicit branch name to create or check out." })),
      ticket_key: Type.Optional(Type.String({ description: "Ticket key such as ABC-123. Used with configured ticket templates." })),
      ticket_title: Type.Optional(Type.String({ description: "Ticket title used to fill the {slug} branch/path template token." })),
      change_type: Type.Optional(Type.String({ description: "Change type for the {type} token, for example feat, fix, chore, docs, refactor." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await createWorktreeService(ctx.cwd, params as WorktreeCreateInput);
      return {
        content: [{ type: "text", text: result.ok
          ? `Created worktree\nPath: ${result.path}\nBranch: ${result.branch}\nStatus: ${result.status}${result.upstream ? `\nUpstream: ${result.upstream}` : ""}`
          : `Failed to create worktree\nStatus: ${result.status}\nPath: ${result.path ?? "(none)"}\nBranch: ${result.branch ?? "(none)"}\nError: ${result.error ?? "unknown error"}` }],
        details: result,
      };
    },
  });

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
        if (input?.trim()) await createWorktree(pi, ctx, input.trim());
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
      if (input) await createWorktree(pi, ctx, input);
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
