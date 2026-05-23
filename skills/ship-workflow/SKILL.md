---
name: ship-workflow
description: "Orchestrate a safe end-to-end local shipping flow: validate, commit, push, open a PR, update ticket context, and prepare reviewer communication. Use when the user asks to ship, finish, yeet, or run the full delivery pipeline."
---

# Ship Workflow

This is an orchestration skill. Delegate details to more specific skills and project instructions.

## Default order

1. Run quality gates (`quality-gates` plus project-specific gate skill).
2. Stage and commit (`conventional-commit`).
3. Push and create/update PR (`github-pr`).
4. Pull/update ticket context if project instructions require it (`jira-context` or equivalent).
5. Generate reviewer communication (`slack-review-request`).
6. Summarize what happened and what remains manual.

## Safety

- Auto-formatting and lint auto-fix are allowed when the user asks to ship/yeet.
- Staging requires user approval.
- The user wants to create commits manually. Draft commit messages, but do not run `git commit` unless explicitly approved.
- Stop on failed gates.
- If a quality gate fails, report the failure and wait. Do not fix, refactor, suppress, revert, or try a different strategy unless the user approves.
- Do not push commits without explicit user approval.
- Do not force-push without explicit confirmation.
- Ask before creating or updating externally visible artifacts: PRs, Jira fields/status/comments, Slack messages sent via CLI/API, deploys, etc.
- Reuse answers and successful gate results from the current chat; do not ask duplicate questions or rerun passed gates unless an approved mutation invalidated them.
- Project-scoped prompts may add concrete commands, ticket lanes, reviewer groups, or templates.
