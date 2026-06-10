---
name: start-ticket
description: "Start work from an issue/ticket safely: sync the base branch, create a feature branch or worktree, infer ticket keys from branch names when needed, pull ticket context, research the codebase, propose a plan, and wait for approval before coding. Use when the user asks to start a Jira/GitHub ticket, begin work from an issue URL/key, or plan work from the current branch."
---

# Start Ticket

This skill starts a ticket without writing code until the user approves the plan.

## Mandatory SalesAI worktree golden path

When the user pastes a Jira ticket URL/key and asks to create/start a new worktree, do **not** merely suggest or print a path. Execute the full setup flow below unless the user explicitly asks for a dry run:

1. Extract the ticket key from the URL/key.
2. Fetch the Jira ticket summary/context first; use the summary to derive the branch slug.
3. Compute the SalesAI worktree path exactly as:
   ```text
   ~/Documents/programming/salesai-worktrees/<TICKET-KEY>
   ```
   Example: `~/Documents/programming/salesai-worktrees/CSU-4215`.
4. Compute the branch using the repo policy:
   ```text
   <type>/<TICKET-KEY>-<short-kebab-case-ticket-summary>
   ```
   Example: `fix/CSU-4215-reminder-enable-configured-actions`.
5. Create the worktree at that exact path from `origin/main`.
6. Hydrate local ignored files from the source SalesAI worktree.
7. Run install/generation from the new worktree root.
8. Verify readiness and report the actual created path.

Never create SalesAI worktrees in `~/Documents/programming/worktrees`, never use ad-hoc names like `browse-<ticket>`, and never hand off a freshly created SalesAI worktree before install/generation/local-file hydration have completed or failed explicitly.

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
3. If no ticket key/ID was provided in the prompt, infer it from the current branch name returned by `git branch --show-current` before asking the user.
   - Match ticket keys case-insensitively anywhere in the branch name and normalize to uppercase, for example `browse-csu-4733` -> `CSU-4733` and `feature/CSU-4213-phone-number-search` -> `CSU-4213`.
   - If exactly one ticket key is found, use it.
   - If multiple ticket keys are found, ask which one to use.
   - If no ticket key is found, ask the user for the ticket key/URL before fetching ticket context.
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

   Worktree path rules are not optional:
   - For the SalesAI repo at `~/Documents/programming/salesai`, create ticket worktrees under `~/Documents/programming/salesai-worktrees/<TICKET-KEY>`.
   - Do **not** create SalesAI ticket worktrees under `~/Documents/programming/worktrees`, inside the main repo, or in any ad-hoc sibling folder.
   - If the intended `<TICKET-KEY>` path already exists, stop and ask before deleting, reusing, or choosing a different name.
   - After creation, run `git worktree list --porcelain` and verify the path is registered and exactly where expected.

   Adapt base branch and branch name to project rules. Never leave the new feature branch tracking `origin/main`; leave upstream unset until the first push to the branch.

   After creating a worktree, hydrate local ignored files before running install/generation:
   - Copy repo-local Pi config when present: `.pi/` and package-level Pi config such as `frontend/.pi/`.
   - Copy frontend local env files when safe: `frontend/.env.local`, `frontend/.env.harness.local`, and `frontend/.env.dev`.
   - Copy only from the source worktree to the same relative paths in the new worktree.
   - Never overwrite existing env/Pi files without asking.
   - Never print secret env values.

   Then bootstrap it enough that the user can `cd` into it and start development. For the SalesAI repo, run these from the new worktree root unless the user opted out:
   ```bash
   npm install
   npm run dev:api-client
   ```
   If `npm install` changes `package-lock.json` only due to platform/npm metadata, restore it unless the ticket intentionally updates dependencies. If package install/generation fails, report the exact failure and do not hand off as ready-to-run.

   Final readiness check before handoff:
   ```bash
   git -C <path> status --short --branch
   test -d <path>/node_modules
   test -f <path>/.nx/nxw.js
   ```

5. Fetch ticket context with the appropriate skill/tool using the provided or inferred ticket key.
6. Research only: inspect likely files, search for relevant identifiers, read docs/tests, and summarize findings.
7. Decide whether the work should be split across multiple branches/PRs. Consider risk, deployability, migrations, UI/backend coupling, and review size.
8. If the ticket is a bug or regression, add a regression-test gate to the plan:
   - State that implementation must use the `bug-fix` workflow next.
   - Sketch the failing regression tests or repro harnesses to add before production-code changes.
   - Make clear that the agent must add/run the failing tests and report failures for approval before fixing code.
   - If no correct test seam is obvious, require the agent to explain that and propose the closest runnable repro before implementation.
9. Record the plan in a temporary project-local Pi plan file before presenting it:
   - Preferred path: `<project-root>/.pi/plan.md`.
   - If operating from a package subdirectory, use that package's `.pi/plan.md` only when it is the established Pi directory for the current worktree; otherwise use the repository root `.pi/plan.md`.
   - Create the `.pi` directory if needed.
   - Treat this file as the deterministic source of truth for the ticket plan during execution.
   - Include the ticket key/link, branch, worktree path when applicable, current date, goal, relevant context found, proposed solution, implementation steps, test/validation plan, risks/open questions, and whether to split into multiple branches/PRs.
   - The proposed solution must be concrete enough to approve or reject. Do not stop at “inspect/verify”; state the likely code change or investigation hypothesis based on the ticket context and code research.
   - Update this file when the user approves a changed plan or when meaningful implementation discoveries alter the plan.
   - Reference this file before implementing, validating, committing, or summarizing ticket work.
10. Present the recorded plan with:
   - plan file path
   - ticket key source: prompt-provided or branch-inferred, including the current branch name when inferred
   - goal
   - relevant context found
   - proposed solution and implementation steps
   - test/validation plan
   - regression-test gate when the ticket is a bug
   - risks and open questions
   - whether to split into multiple branches/PRs
11. Ask for approval before editing code.

Stop after recording and presenting the plan unless the user explicitly approves implementation.
