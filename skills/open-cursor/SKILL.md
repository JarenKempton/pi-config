---
name: open-cursor
description: Opens the current working directory in the existing Cursor window using the local cr shell helper or cursor --reuse-window. Use when the user asks to open the current folder/worktree in Cursor.
---

# Open Cursor

Open the current working directory in the existing Cursor window. Keep this skill intentionally minimal and fast: do not inspect git state, read project files, or do extra analysis.

Run exactly one of these commands from the current directory:

```bash
zsh -lc 'source ~/.zshrc >/dev/null 2>&1; cr'
```

If that fails because `cr` is unavailable, run:

```bash
cursor --reuse-window "$PWD"
```

If `cursor` is not found, tell the user to install Cursor's shell command from Cursor: Command Palette → "Shell Command: Install 'cursor' command in PATH".
