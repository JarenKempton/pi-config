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

3. Restart Pi, or run `/reload` from inside Pi.

4. Optional: apply the shared settings from this repo:

   ```bash
   cp ~/.pi/agent/git/github.com/JarenKempton/pi-config/settings.json ~/.pi/agent/settings.json
   ```

   Keep `~/.pi/agent/auth.json` local. Do not commit auth files or API keys.

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
