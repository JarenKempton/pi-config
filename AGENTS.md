# Personal Pi Config Instructions

When the user asks to create, build, update, improve, or install a personal Pi skill, extension, prompt template, or theme, use this repository as the single source of truth.

Canonical config repo:

```text
~/.pi/agent/pi-config
```

This path is a symlink to Pi's installed git package checkout:

```text
~/.pi/agent/git/github.com/JarenKempton/pi-config
```

Rules:

- Before installing packages, upgrading tools, changing global configuration, or otherwise mutating the host system outside the current repository, explain the intended command/change and ask for explicit user approval. This is especially important for global package managers such as `npm install -g`, Homebrew, pipx/pip, system browser tooling, shell profile edits, and credential/auth tooling.
- Create personal skills in `~/.pi/agent/pi-config/skills/<skill-name>/SKILL.md`.
- Create personal extensions in `~/.pi/agent/pi-config/extensions/<extension-name>.ts`.
- Create personal prompt templates in `~/.pi/agent/pi-config/prompts/<name>.md`.
- Create personal themes in `~/.pi/agent/pi-config/themes/<name>.json`.
- Do not create shared personal resources in `~/.pi/agent/skills`, `~/.pi/agent/extensions`, `~/.pi/agent/prompts`, `~/.pi/agent/themes`, project `.pi/` folders, or other local-only locations unless the user explicitly asks for machine-local or project-local config.
- After changing this repo, check `git -C ~/.pi/agent/pi-config status` and make sure the change is committed and pushed.
