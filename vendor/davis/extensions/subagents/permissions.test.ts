import assert from "node:assert/strict";
import test from "node:test";
import {
  claudeOptionsForProfile,
  codexOptionsForProfile,
  codexServerArgsForProfile,
  piToolPolicyForProfile,
} from "./src/permissions.ts";
import { assertCwdAllowed, normalizeProfile } from "./src/safety.ts";

test("subagent profiles default to scout and guard cwd confinement", () => {
  assert.equal(normalizeProfile(undefined), "scout");
  assert.equal(normalizeProfile("worker"), "worker");
  assert.throws(
    () => assertCwdAllowed("/repo", "/tmp", "scout"),
    /outside parent project/,
  );
  assert.doesNotThrow(() =>
    assertCwdAllowed("/repo", "/tmp", "unrestricted"),
  );
  assert.doesNotThrow(() =>
    assertCwdAllowed("/repo", "/repo/pkg", "worker"),
  );
});

test("backend permission mappings are profile-specific and fail closed", () => {
  const scoutClaude = claudeOptionsForProfile("scout");
  assert.equal(scoutClaude.permissionMode, "dontAsk");
  assert.deepEqual(scoutClaude.tools, ["Read", "Grep", "Glob", "LS"]);

  const researcherClaude = claudeOptionsForProfile("researcher");
  assert.equal(researcherClaude.tools.includes("WebSearch"), true);
  assert.equal(researcherClaude.tools.includes("WebFetch"), true);

  const workerClaude = claudeOptionsForProfile("worker");
  assert.equal(workerClaude.permissionMode, "acceptEdits");
  assert.equal(workerClaude.sandbox.allowUnsandboxedCommands, false);
  assert.equal("allowedTools" in workerClaude, false);

  assert.deepEqual(codexOptionsForProfile("scout"), {
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  assert.deepEqual(codexOptionsForProfile("worker"), {
    approvalPolicy: "never",
    sandbox: "workspace-write",
  });
  assert.deepEqual(codexOptionsForProfile("unrestricted"), {
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  });
  assert.equal(
    codexServerArgsForProfile("scout").includes('web_search="disabled"'),
    true,
  );
  assert.equal(
    codexServerArgsForProfile("researcher").includes('web_search="live"'),
    true,
  );
  assert.equal(
    codexServerArgsForProfile("worker").includes("mcp_servers={}"),
    true,
  );
  assert.deepEqual(codexServerArgsForProfile("unrestricted"), [
    "app-server",
    "--stdio",
  ]);

  assert.deepEqual(piToolPolicyForProfile("scout"), {
    tools: ["read", "grep", "find", "ls"],
  });
  assert.deepEqual(piToolPolicyForProfile("researcher"), {
    tools: ["read", "grep", "find", "ls", "web_search", "web_fetch"],
  });
  assert.deepEqual(piToolPolicyForProfile("worker"), {
    tools: ["read", "grep", "find", "ls", "write", "edit"],
  });
});
