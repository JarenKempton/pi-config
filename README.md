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

   The extension also repairs these symlinks on Pi startup, but running the bootstrap script makes the first startup deterministic.

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
  "deleteRemoteBranches": false
}
```

Use that project-local config for organization-specific behavior. Keep `generic-worktrees.ts` abstract and only change it when the common workflow itself is wrong.

Environment variables are also supported for portable defaults:

- `PI_WORKTREE_BASE_BRANCH`
- `PI_WORKTREE_REMOTE`
- `PI_WORKTREE_PUSH_NEW_BRANCHES=0`
- `PI_WORKTREE_DELETE_LOCAL_BRANCHES=0`
- `PI_WORKTREE_DELETE_REMOTE_BRANCHES=1`

## Updating this config

Inside Pi, use the package commands from `extensions/pi-config-git.ts`:

```text
/pi-config-status
/pi-config-pull
/pi-config-push
```

What they do:

- `/pi-config-status` shows git status for the installed package checkout.
- `/pi-config-pull` runs `git pull --ff-only` for the installed package checkout.
- `/pi-config-push` commits local package changes with a `pi config:` commit message, then pushes to GitHub.

After pulling changes, run `/reload` or restart Pi so resources are refreshed.

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
