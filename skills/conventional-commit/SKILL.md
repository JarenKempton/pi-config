---
name: conventional-commit
description: Create conventional commit messages from staged diffs. Use when committing, preparing commits, reviewing commit messages, or naming PRs that follow conventional commit style.
---

# Conventional Commit

## Format

`<type>(<scope>): <subject>`

Common types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.

## Rules

- Inspect the staged diff, not just the working tree.
- Use repo-specific rules if present (`.commitlintrc`, AGENTS.md, project skills).
- Subject should be imperative, concise, lowercase unless a proper noun requires casing, and have no trailing period.
- Add a body when useful to explain why, tradeoffs, or migration notes.
- Do not include unrelated changes in the message.

## Safe commit sequence

```bash
git status
git diff --cached --stat
git diff --cached
```

If nothing is staged, do not commit.

Use a heredoc for multi-line messages:

```bash
git commit -m "$(cat <<'EOF'
<type>(<scope>): <subject>

<body>
EOF
)"
```
