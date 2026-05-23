---
name: github-pr
description: Create or update GitHub pull requests with gh CLI. Use when pushing branches, opening PRs, drafting PR descriptions, detecting existing PRs, or summarizing changes for review.
---

# GitHub PR

Use `gh` CLI and repo-specific PR rules/templates when present.

## Flow

1. Check auth if needed: `gh auth status`.
2. Push safely: `git push -u origin HEAD`.
3. Detect existing PR for the current branch:
   ```bash
   gh pr list --head "$(git branch --show-current)" --state open --json number,url,title
   ```
   If one exists, report it and do not create a duplicate.
4. Build the title/body from:
   - `git log main..HEAD`
   - `git diff main...HEAD`
   - repo PR template, if any
   - ticket context, if available
5. Show the proposed title/body and ask for approval before creating the PR unless the user explicitly said not to ask.
6. Create with a temp body file:
   ```bash
   gh pr create --title "<title>" --body-file <file>
   ```

Never force-push unless the user explicitly asks and confirms the risk.
