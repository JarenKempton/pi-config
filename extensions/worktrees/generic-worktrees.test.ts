import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  branchNameForCreateInput,
  createWorktreeService,
  targetFolderNameForCreateInput,
} from "../generic-worktrees.ts";

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tempRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-worktrees-test-"));
  const remote = path.join(dir, "remote.git");
  const repo = path.join(dir, "repo");
  git(dir, ["init", "--bare", remote]);
  mkdirSync(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test User"]);
  writeFileSync(path.join(repo, "README.md"), "# test\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "initial"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  return { dir, repo };
}

const config = {
  baseBranch: "main",
  remote: "origin",
  pushNewBranches: false,
  deleteLocalBranches: true,
  deleteRemoteBranches: false,
};

test("ticket templates keep generic defaults and ticket-key folder behavior", (t) => {
  const { dir, repo } = tempRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.equal(
    branchNameForCreateInput(repo, config, {
      ticket_key: "ABC-123",
      ticket_title: "Add Safer Worktrees",
      change_type: "feat",
    }),
    "feat/ABC-123-add-safer-worktrees",
  );
  assert.equal(
    targetFolderNameForCreateInput(
      config,
      { ticket_key: "ABC-123", ticket_title: "Add Safer Worktrees" },
      "feat/ABC-123-add-safer-worktrees",
    ),
    "ABC-123",
  );
  assert.equal(
    branchNameForCreateInput(
      repo,
      {
        ...config,
        ticket: { branchTemplate: "{type}/{key}", pathTemplate: "{key}" },
      },
      { input: "ABC-123" },
    ),
    "feat/ABC-123",
  );
});

test("rejects path traversal from ticket path templates", async (t) => {
  const { dir, repo } = tempRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(repo, ".pi"));
  writeFileSync(
    path.join(repo, ".pi", "worktrees.json"),
    JSON.stringify({
      ...config,
      worktreesDir: "../worktrees",
      ticket: { pathTemplate: "../{key}" },
    }),
  );

  const result = await createWorktreeService(repo, {
    ticket_key: "ABC-123",
    ticket_title: "Unsafe Path",
  });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Unsafe worktree target path/);
});

test("creates, hydrates without overwrite, bootstraps, and reports status", async (t) => {
  const { dir, repo } = tempRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(repo, ".pi"));
  writeFileSync(path.join(repo, ".env.local"), "SECRET=do-not-print\n");
  writeFileSync(
    path.join(repo, ".pi", "worktrees.json"),
    JSON.stringify({
      ...config,
      worktreesDir: "../worktrees",
      copyFromPrimary: [".env.local"],
      bootstrapCommands: ["printf boot > boot.txt"],
      verifyPaths: [".env.local", "boot.txt"],
      ticket: { branchTemplate: "{type}/{key}", pathTemplate: "{key}" },
    }),
  );

  const request = {
    ticket_key: "ABC-123",
    ticket_title: "Create Test",
    change_type: "fix",
  };
  const result = await createWorktreeService(repo, request);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.branch, "fix/ABC-123");
  assert.equal(path.basename(result.path ?? ""), "ABC-123");
  assert.equal(path.basename(path.dirname(result.path ?? "")), "worktrees");
  assert.match(result.status, /created fix\/ABC-123/);
  assert.equal(
    readFileSync(path.join(result.path!, ".env.local"), "utf8"),
    "SECRET=do-not-print\n",
  );
  assert.equal(readFileSync(path.join(result.path!, "boot.txt"), "utf8"), "boot");
  assert.equal(
    git(result.path!, ["rev-parse", "--abbrev-ref", "HEAD"]),
    "fix/ABC-123",
  );

  let upstream = "";
  try {
    upstream = git(repo, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "fix/ABC-123@{upstream}",
    ]);
  } catch {}
  assert.notEqual(upstream, "origin/main");

  const collision = await createWorktreeService(repo, request);
  assert.equal(collision.ok, false);
  assert.equal(collision.status, "collision");
});
