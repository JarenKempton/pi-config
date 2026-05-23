---
name: start-ticket
description: "Start work from an issue/ticket safely: sync the base branch, create a feature branch or worktree, infer ticket keys from branch names when needed, pull ticket context, research the codebase, propose a plan, and wait for approval before coding. Use when the user asks to start a Jira/GitHub ticket, begin work from an issue URL/key, or plan work from the current branch."
---

# Start Ticket

This skill starts a ticket without writing code until the user approves the plan.

## Safety rules

- Do not write or edit source code before the user approves the plan.
- Do not create a branch or worktree unless the user explicitly asked to start/create one and the working tree is clean.
- If the working tree is dirty, stop and ask the user to commit, stash, or discard changes.
- Use the repo's documented base branch and branch naming rules when available. Default base branch is `main`.
- Prefer local CLI tools for ticket context (`jira-context`, `gh`, `acli`, `jira`).

## Workflow

1. Extract ticket key/ID and title/context from the user's prompt when provided.
2. Check repository state:
   ```bash
   git status --short
   git branch --show-current
   ```
3. If no ticket key/ID was provided in the prompt, infer it from the current branch name returned by `git branch --show-current`:
   - Look for common ticket key formats such as `ABC-123`, `CSU-4213`, or other uppercase project-key plus number patterns anywhere in the branch name.
   - Accept keys embedded in prefixes/suffixes, for example `feature/CSU-4213-phone-number-search` -> `CSU-4213`.
   - If multiple plausible keys are found, ask the user which one to use before continuing.
   - If no ticket key can be inferred, ask the user for the ticket key/URL before fetching ticket context.
4. If branch/worktree creation is requested and the tree is clean, sync the base branch and create the requested workspace shape:
   - Plain branch in the current worktree:
     ```bash
     git fetch origin main
     git checkout -b <branch-name> --no-track origin/main
     ```
   - New worktree for the feature branch:
     ```bash
     git fetch origin main
     git worktree add -b <branch-name> <path> origin/main
     git -C <path> branch --unset-upstream 2>/dev/null || true
     ```
   Adapt base branch/branch name and worktree path to project rules. Never leave the new feature branch tracking `origin/main`; leave upstream unset until the first push to the branch.

   After creating a worktree, bootstrap it enough that the user can `cd` into it and start development. For the SalesAI repo, run these from the new worktree root unless the user opted out:
   ```bash
   npm install
   npm run dev:api-client
   ```
   Then hydrate frontend local env files when safe:
   - If the source worktree has `frontend/.env.local`, `frontend/.env.harness.local`, or `frontend/.env.dev` and the new worktree lacks them, copy them to the same paths in the new worktree.
   - Never overwrite existing env files without asking.
   - Never print secret env values.
   - If package install/generation fails, report the exact failure and do not hand off as ready-to-run.

5. Fetch ticket context with the appropriate skill/tool using the provided or inferred ticket key.
6. Research only: inspect likely files, search for relevant identifiers, read docs/tests, and summarize findings.
7. Decide whether the work should be split across multiple branches/PRs. Consider risk, deployability, migrations, UI/backend coupling, and review size.
8. Record the plan in a temporary project-local Pi plan file before presenting it:
   - Preferred path: `<project-root>/.pi/plan.md`.
   - If operating from a package subdirectory, use that package's `.pi/plan.md` only when it is the established Pi directory for the current worktree; otherwise use the repository root `.pi/plan.md`.
   - Create the `.pi` directory if needed.
   - Treat this file as the deterministic source of truth for the ticket plan during execution.
   - Include the ticket key/link, branch, worktree path when applicable, current date, goal, relevant context found, proposed implementation steps, test/validation plan, risks/open questions, and whether to split into multiple branches/PRs.
   - Update this file when the user approves a changed plan or when meaningful implementation discoveries alter the plan.
   - Reference this file before implementing, validating, committing, or summarizing ticket work.
9. Present the recorded plan with:
   - plan file path
   - ticket key source: prompt-provided or branch-inferred
   - goal
   - relevant context found
   - proposed implementation steps
   - test/validation plan
   - risks and open questions
   - whether to split into multiple branches/PRs
10. Ask for approval before editing code.

Stop after recording and presenting the plan unless the user explicitly approves implementation.
