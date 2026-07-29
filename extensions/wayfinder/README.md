# Wayfinder Cockpit

A persistent Pi TUI for navigating Jira or GitHub epics and local Wayfinder maps, inspecting tracker context, configuring agent routing, and operating linked foreground/background agent sessions.

## Open

Run Pi inside a configured repository or one containing a local Markdown map, then use:

```text
/wayfinder
```

`Alt+W` opens the cockpit and `Alt+A` opens directly to Agent activity. Inside the pane, `m` returns to maps and `g` opens Agent activity.

## Data ownership

- Map and ticket content: the repository's configured canonical issue tracker.
- For workspaces configured to Jira, Jira owns current execution status, assignment, hierarchy, blockers, progress comments, and completion. GitHub issues may preserve historical Wayfinder research, but they are not consulted for current status after an explicit migration marker points to Jira.
- Worktrees and branches: Git.
- Pull requests and reviews: the configured review provider.
- Workspace configuration: `~/.pi/agent/wayfinder/settings.json`.
- Agent/session associations: `~/.pi/agent/wayfinder/state.json`.
- Stale-while-revalidate tracker cache: `~/.pi/agent/wayfinder/cache/`.
- Repository process heartbeats: `~/.pi/agent/wayfinder/heartbeats/`.

The local files are versioned JSON, written atomically with private permissions, and loaded on every new Pi session. The cockpit opens from cache immediately, refreshes tracker data in the background, and reconciles it every 60 seconds while open. Press `r` for an immediate Jira refresh. Credentials remain in provider CLIs and environment variables.

## Navigation

- `↑/↓`, `Enter`, `Esc`: select, open, and return.
- `1`–`3`: switch map layout.
- `c`: complete map context.
- `g`: repository activity (ready work, moving agents, input needed, results, failures, and resolved work).
- `s`: settings.
- `n`: start an agent from the selected ticket in either the map details list or ticket view.
- `j`: jump to or take over the selected ticket's linked agent from either view.
- `x`: cancel a running linked agent from either view.
- `r`: refresh Jira immediately, or retry on-demand comments and dependency hydration for other trackers.

Context documents scroll with `↑/↓` and `PgUp/PgDn`. Inside settings value editors, `←/→` cycles capability-valid values.

## Agent behavior

Starting a leaf ticket shows an inline confirmation inside the Wayfinder modal. On confirmation, an unclaimed GitHub ticket is claimed before spawn; a Jira To Do leaf moves to In Progress before spawn. If spawning fails, Wayfinder attempts to return that Jira leaf to To Do. Execution parents and native Blocked Jira tickets cannot be started. Started agents remain in the background while the cockpit stays on the current map selection, so several ready leaves can be launched in sequence. Press `j` when you want to join or take over a selected agent.

Active sessions use the shared subagent host. Session identifiers and transcript paths are persisted so settled runs remain visible after restarting Pi. Open cockpits poll repository state, and private process heartbeats distinguish agents owned by a live Pi process from interrupted runs. Active sessions can be taken over by their owning Pi process; spectator processes stay read-only rather than creating concurrent session writers. Archived Pi sessions can be opened directly from the slash-command context. Other archived runtimes expose their transcript path and can be continued from the ticket.

The production adapters are Jira, GitHub Issues, and local Markdown. A repository may declare `Issue tracker: Jira` in `docs/agents/issue-tracker.md`; that declaration becomes the default for a workspace without persisted settings. The Jira adapter uses the official Atlassian CLI (`acli`) for reads and for the confirmed To Do → In Progress transition when an agent starts. Jira epics are map roots; every active descendant is loaded, including execution parents and subtasks. Native Jira workflow status—not assignment alone—drives READY, ACTIVE, BLOCKED, and RESOLVED presentation. Parent keys, labels, progress comments, and native blocking links feed the cockpit and spawned-agent prompt. Jira settings include a per-workspace board selector; `←/→` chooses a board and Enter applies it. Wayfinder scopes active epics to the projects associated with that board, with Jaren's Workbench (board `6`) as the personal default. `WAYFINDER_JIRA_MAP_JQL` overrides the board scope when a workspace needs a narrower team, label, or hierarchy query. Install and authenticate ACLI separately with `acli auth login` before selecting Jira in Wayfinder settings.

A GitHub map root is discovered from either the repository's `epic` label or the Wayfinder-specific `wayfinder:map` label; both use native sub-issues, so existing epics do not need relabelling. Root summaries are refreshed in parallel; full comments and dependency edges hydrate only when a ticket opens. The loader also follows explicit migration markers for Jira or Linear: a GitHub map or ticket that declares the other tracker as the source of truth and links its canonical board/issue is shown as a read-only `MOVED` historical mirror.

When GitHub tracker instructions are absent but the repository contains `map.md` or `wayfinder.md`, Wayfinder automatically uses the Markdown adapter. Each map owns an adjacent `issues/` directory. Discovery ignores `.claude/` so linked worktree copies do not appear as duplicate maps. Issue files support `Type:`, `Status:`, `Blocked by:`, and optional `Mode:` fields plus normal Markdown sections such as `## Question` and `## Answer`. Resolved issue dependencies no longer block downstream frontier work. Markdown remains canonical; opening or running an agent does not silently rewrite the files. Other tracker types remain capability previews until their adapters are installed.
