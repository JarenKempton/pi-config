---
name: what-gives
description: Explains what a Jira ticket is really asking for, likely implementation scope, complexity, risks, and whether it should be split. Use when the user runs /what-gives or /what_gives with a Jira key/URL, asks "what gives" about a ticket, or wants ticket triage/context without starting implementation.
---

# What Gives

Triage a Jira ticket and explain what it means before any implementation work.

## Goal

Give the user a practical read on:

- What the ticket is asking for in plain English
- User-visible behavior / acceptance criteria
- Relevant related tickets, comments, decisions, or dependencies
- Likely code areas involved
- Complexity: quick fix, moderate, or intense
- Whether it should be one PR or split into multiple PRs
- Risks, unknowns, and recommended next steps

## Workflow

1. **Extract the Jira key** from the prompt/URL using `[A-Z]+-[0-9]+`.
   - If no key is present, ask for a Jira key or URL.

2. **Fetch Jira context first** using local CLI tools, preferring `acli` then `jira`:
   ```bash
   command -v acli && acli auth status
   command -v jira && jira me
   acli jira workitem view <KEY> || acli jira issue view <KEY> || jira issue view <KEY>
   ```
   - Capture summary, type, status, description, assignee, comments if visible, linked issues if the CLI exposes them.
   - Do not claim missing fields are absent; say they were not visible via CLI.

3. **Inspect the codebase only as needed.**
   - Search for domain terms from the summary/description.
   - For SalesAI frontend tickets, start in `frontend/` and message files/tests when relevant.
   - For backend/service tickets, inspect matching service folders, OpenAPI specs, migrations, and tests.
   - Keep this lightweight: enough to estimate scope, not enough to implement.

4. **Do not create branches, worktrees, commits, PRs, or edit source code.**
   - This is triage/context only.
   - If the user asks to start work after the triage, hand off to `start-ticket`.

## Output format

Respond with these headings:

```md
## What this ticket is about

## Important context from Jira

## Relevant code areas

## Complexity read
Quick / Moderate / Intense — explain why.

## PR split recommendation
One PR / Split — explain why and suggest split boundaries if needed.

## Risks and unknowns

## Recommended next steps
```

Keep it concise but useful. Be candid when the ticket is ambiguous or likely larger than it looks.
