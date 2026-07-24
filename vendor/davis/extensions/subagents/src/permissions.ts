import type { SubagentProfile } from "./domain.ts";
import { childToolPolicy } from "../../shared/project-tool-policy.ts";

const CLAUDE_SCOUT_TOOLS = ["Read", "Grep", "Glob", "LS"];
const CLAUDE_RESEARCHER_TOOLS = [
  ...CLAUDE_SCOUT_TOOLS,
  "WebSearch",
  "WebFetch",
];
const CLAUDE_WORKER_TOOLS = [
  ...CLAUDE_SCOUT_TOOLS,
  "Write",
  "Edit",
  "Bash",
];

export function claudeOptionsForProfile(profile: SubagentProfile) {
  if (profile === "unrestricted") {
    return {
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    } as const;
  }

  if (profile === "worker") {
    return {
      tools: CLAUDE_WORKER_TOOLS,
      permissionMode: "acceptEdits",
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
      },
    } as const;
  }

  const tools =
    profile === "researcher"
      ? CLAUDE_RESEARCHER_TOOLS
      : CLAUDE_SCOUT_TOOLS;
  return {
    tools,
    permissionMode: "dontAsk",
    allowedTools: tools,
    disallowedTools: ["Write", "Edit", "MultiEdit", "Bash"],
  } as const;
}

export function codexServerArgsForProfile(profile: SubagentProfile) {
  if (profile === "unrestricted") return ["app-server", "--stdio"];
  return [
    "app-server",
    "--stdio",
    "-c",
    "mcp_servers={}",
    "-c",
    profile === "researcher"
      ? 'web_search="live"'
      : 'web_search="disabled"',
  ];
}

export function codexOptionsForProfile(profile: SubagentProfile) {
  if (profile === "unrestricted") {
    return { approvalPolicy: "never", sandbox: "danger-full-access" } as const;
  }
  if (profile === "worker") {
    return { approvalPolicy: "never", sandbox: "workspace-write" } as const;
  }
  return { approvalPolicy: "never", sandbox: "read-only" } as const;
}

export function piToolPolicyForProfile(profile: SubagentProfile) {
  return childToolPolicy(profile);
}
