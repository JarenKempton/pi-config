import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertProjectPath, childToolPolicy } from "./project-tool-policy.ts";

test("worker tool policy is an allowlist without shell access", () => {
  assert.deepEqual(childToolPolicy("worker"), {
    tools: ["read", "grep", "find", "ls", "write", "edit"],
  });
});

test("project path guard rejects traversal and symlink escapes", () => {
  const base = mkdtempSync(join(tmpdir(), "pi-project-guard-"));
  const project = join(base, "project");
  const outside = join(base, "outside");
  mkdirSync(project);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "secret");
  symlinkSync(outside, join(project, "escape"));

  assert.doesNotThrow(() => assertProjectPath(project, "src/new.ts"));
  assert.throws(
    () => assertProjectPath(project, "../outside/secret.txt"),
    /outside the current project/,
  );
  assert.throws(
    () => assertProjectPath(project, "escape/secret.txt"),
    /symlink|outside the current project/,
  );
});
