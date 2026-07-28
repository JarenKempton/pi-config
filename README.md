# pi-config

Personal [Pi](https://pi.dev) package for extensions, skills, themes, and default settings.

## How Pi installs this repo

Use Pi's built-in package system instead of cloning this repo into `~/code`.

```bash
pi install git:git@github.com:JarenKempton/pi-config
```

Pi installs the repo here by convention:

```text
~/.pi/agent/git/github.com/JarenKempton/pi-config
```

That installed directory is the canonical local checkout. Pi loads resources from it on startup:

- `extensions/` — custom slash commands, widgets, and tools
- `skills/` — agent skills
- `themes/` — themes
- `settings.json` — portable defaults you can copy or symlink if desired

## Local layout

Keep shared config in the Git package checkout only:

```text
~/.pi/agent/git/github.com/JarenKempton/pi-config
```

Do not keep separate local copies in these folders:

```text
~/.pi/agent/extensions
~/.pi/agent/prompts
~/.pi/agent/skills
~/.pi/agent/themes
```

Those folders should be absent unless you intentionally need machine-local, non-shared resources. Shared resources belong in this repo and are loaded through the `packages` entry in `~/.pi/agent/settings.json`.

Keep machine-local/private files outside the repo, for example:

- `~/.pi/agent/auth.json`
- `~/.pi/agent/sessions/`
- `~/.pi/agent/bin/`
- crash logs or other local runtime files

## Fresh machine setup

1. Install Pi and authenticate:

   ```bash
   pi
   /login
   ```

2. Install this config package:

   ```bash
   pi install git:git@github.com:JarenKempton/pi-config
   ```

3. Bootstrap the global context-file symlink:

   ```bash
   ~/.pi/agent/git/github.com/JarenKempton/pi-config/bootstrap.sh
   ```

   This creates:

   ```text
   ~/.pi/agent/pi-config -> ~/.pi/agent/git/github.com/JarenKempton/pi-config
   ~/.pi/agent/AGENTS.md -> ~/.pi/agent/pi-config/AGENTS.md
   ```

4. Restart Pi, or run `/reload` from inside Pi.

5. Make sure `~/.pi/agent/settings.json` points at this package:

   ```json
   {
     "packages": ["git:git@github.com:JarenKempton/pi-config"]
   }
   ```

   You can also copy the shared defaults from this repo, then keep the `packages` entry:

   ```bash
   cp ~/.pi/agent/git/github.com/JarenKempton/pi-config/settings.json ~/.pi/agent/settings.json
   ```

   Keep `~/.pi/agent/auth.json` local. Do not commit auth files or API keys.

## Worktrees command

The shared `/worktrees`, `/create-worktree`, and `/delete-worktree` commands live in:

```text
extensions/generic-worktrees.ts
```

Default behavior:

- Creates worktrees under `../worktrees` relative to the primary checkout.
- Creates new local branches from `origin/main` by default.
- Immediately pushes new branches with `git push --set-upstream origin <branch>`, so feature branches track `origin/<branch>` instead of `origin/main`.
- Deletes worktrees with one confirmation, then removes the folder, prunes git worktree metadata, deletes the local branch, and deletes the local remote-tracking ref.
- Does **not** delete remote branches unless configured to do so.

Per-project overrides belong in one of these files in the repo you are working on:

```text
.pi/worktrees.json
.pi/worktrees.config.json
```

Example:

```json
{
  "baseBranch": "main",
  "remote": "origin",
  "worktreesDir": "../worktrees",
  "pushNewBranches": true,
  "deleteLocalBranches": true,
  "deleteRemoteBranches": false,
  "copyFromPrimary": [".env.local"],
  "bootstrapCommands": ["npm install"],
  "verifyPaths": ["node_modules"],
  "verifyCommands": ["npm test"],
  "ticket": {
    "branchTemplate": "{type}/{key}-{slug}",
    "pathTemplate": "{key}-{slug}"
  }
}
```

The `worktree_create` tool uses the same service as the commands, so ticket skills do not need to duplicate Git or bootstrap logic. Bootstrap commands execute only after the user explicitly invokes worktree creation; keep them project-specific and reviewable.

Use that project-local config for organization-specific behavior. Keep `generic-worktrees.ts` abstract and only change it when the common workflow itself is wrong.

Environment variables are also supported for portable defaults:

- `PI_WORKTREE_BASE_BRANCH`
- `PI_WORKTREE_REMOTE`
- `PI_WORKTREE_PUSH_NEW_BRANCHES=0`
- `PI_WORKTREE_DELETE_LOCAL_BRANCHES=0`
- `PI_WORKTREE_DELETE_REMOTE_BRANCHES=1`

## Orchestration and local reporting

The vendored Davis orchestration package provides background Pi, Claude, Codex, and read-only Cursor agents, takeover UI, configurable harness/model presets, workflows, private run artifacts, and the dashboard. The default profile is read-only:

- `scout`: local read/search only
- `researcher`: read/search plus web tools
- `worker`: writes restricted to the current project; no shell tool
- `unrestricted`: explicit per-spawn interactive confirmation; rejected headlessly

See [`vendor/davis/UPSTREAM.md`](vendor/davis/UPSTREAM.md) and [`vendor/davis/PATCHES.md`](vendor/davis/PATCHES.md) before syncing upstream.

Other commands and tools:

- Escape is guarded during an active agent run. Instead of aborting immediately, Pi asks for explicit confirmation; Escape still dismisses autocomplete and confirmation dialogs normally.
- `/subagents` (or `Alt+S`) opens the background-agent list and takeover view in a bounded modal. With an empty takeover input, `c` copies the latest answer and `Shift+C` copies a reasoning-safe Markdown transcript. BTW runs additionally support `q` to queue the latest answer into the parent and `w` to review/approve a work contract, approve a project-confined executioner, and spawn a fresh worker. Press `s` in the dashboard—or use `/subagent-settings` directly—to configure future harness, model, effort, profile, and preset defaults from `subagents.json`.
- `/wayfinder` opens the cockpit for Jira or GitHub epics, Wayfinder-labelled issues, or local `map.md`/`wayfinder.md` maps with an adjacent `issues/` ledger. `Alt+W` opens the cockpit; `Alt+A` opens Agent activity. Jira uses the official `acli` client and supports an optional `WAYFINDER_JIRA_MAP_JQL` map-root query. Configuration and run associations live privately under `~/.pi/agent/wayfinder/`; tracker content remains canonical in the configured issue tracker or Markdown files.
- `/usage` (or `Alt+U`) opens refreshable Codex, Claude, and Cursor account status. Codex/Claude quota windows use progress bars; Cursor shows the authenticated subscription tier and active model because its CLI does not expose deterministic quota percentages. It is safe during an active run and never writes to the transcript or model context.
- `/cost [today|7d|30d|all]` (or `Alt+C`) opens local API-equivalent history in a period-switchable overlay with model totals and proportional cost bars. The footer separately shows current-chat cost, current-session subagent cost, and today's cross-model local tally.
- `/lg` opens `hunk diff --watch` in macOS Terminal at the exact current worktree.
- `browser_qa` is the default browser path. It delegates a precise visual task to Codex Computer Use in the user's existing Helium session, automatically handles the allow-listed app-access elicitation, and returns the report plus screenshot evidence. Use the Playwright `authenticated-browser` MCP only when DOM, console, network, or tracing access is specifically required and healthy.
- `web_search` uses Firecrawl when a local key is available and falls back to DuckDuckGo.
- `web_fetch` tries bounded direct HTTP first, then Firecrawl for difficult pages.

Keep `FIRECRAWL_API_KEY` and `~/.pi/agent/private/` local and untracked. `bin/claude-statusline.mjs` is an optional cache-aware status-line helper; installing it into Claude settings is a separate host-level action.

## Development and updates

Use explicit Git operations or Pi's installation-native package update flow. This package intentionally has no auto-commit or auto-push command.

```bash
npm install
npm run typecheck
npm test
```

The quota-consuming Claude/Codex integration tests are intentionally separate:

```bash
npm run test:live
```

Run them only with explicit approval. After pulling package changes, run `/reload` or restart Pi.

## Manual git commands

If needed, operate directly in Pi's package checkout:

```bash
cd ~/.pi/agent/git/github.com/JarenKempton/pi-config
git status
git pull --ff-only
git add .
git commit -m "pi config: update config"
git push
```

## Notes

- Do not use `~/code/pi-config` as a special path. Pi's package checkout under `~/.pi/agent/git/...` is the standard location.
- If a machine already has an old manual clone, either remove it or ignore it after installing this package through `pi install`.
- If local `~/.pi/agent/extensions`, `prompts`, `skills`, or `themes` folders already exist, migrate anything useful into this repo, push it, then remove the local folders to avoid split-brain config.
