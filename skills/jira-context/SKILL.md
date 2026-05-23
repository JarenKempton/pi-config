---
name: jira-context
description: Pulls Jira ticket context using local CLI tools such as acli, jira, or gh, then turns it into concise task context. Use when the user provides a Jira key or URL and asks to understand, start, summarize, or work from a ticket.
---

# Jira Context

Use local command-line tools; do not assume MCP tools are available.

## Inputs

Accept Jira keys like `CSU-1234` or URLs containing a key. Extract keys with `[A-Z]+-[0-9]+`.

## Preferred CLI order

1. If `acli` exists, prefer Atlassian CLI.
2. Else if `jira` exists, use the installed Jira CLI.
3. Else ask the user to paste the ticket text or install/authenticate a CLI.

## Commands

Check auth/tooling first:

```bash
command -v acli && acli auth status
command -v jira && jira me
```

For `acli`, try these in order because versions differ:

```bash
acli jira workitem view <KEY>
acli jira issue view <KEY>
```

For `jira` CLI, try:

```bash
jira issue view <KEY>
```

## Output shape

After fetching ticket data, summarize:

- Goal
- Acceptance criteria / user-visible behavior
- Important comments or decisions
- Linked issues/PRs if visible
- Unknowns to ask the user
- Suggested first repo-inspection steps

Keep quoted ticket text brief; paraphrase where possible.
