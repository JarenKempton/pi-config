---
name: quality-gates
description: Run project quality gates safely before committing or shipping. Use when the user asks to check, validate, test, lint, typecheck, or prepare work for commit/PR.
---

# Quality Gates

Use the project's documented commands when available (`AGENTS.md`, `.pi/skills`, package scripts, Makefile, README, CI config). Prefer the narrowest gates relevant to changed files.

## Workflow

1. Inspect changed files with `git status --short`.
2. Identify project-specific gates from loaded project skills/prompts or repo docs.
3. Run auto-fix gates before non-auto-fix gates.
4. If a gate fails, fix the cause and restart from the first formatting/auto-fix step.
5. Do not bypass checks unless the user explicitly asks.
6. Report exactly what passed, failed, or was skipped.

## Stop rule

Running gates does not imply staging, committing, pushing, opening PRs, or touching ticket systems.
