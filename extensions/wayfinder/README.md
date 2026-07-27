# Wayfinder Cockpit

A persistent Pi TUI for navigating Jira or GitHub epics and local Wayfinder maps, inspecting tracker context, configuring agent routing, and operating linked foreground/background agent sessions.

## Open

Run Pi inside a configured repository or one containing a local Markdown map, then use:

```text
/wayfinder
```

`Alt+W` opens the cockpit and `Alt+A` opens directly to Agent activity. Inside the pane, `m` returns to maps and `g` opens Agent activity.

## Data ownership

- Map and ticket content: the repository's configured issue tracker.
- Worktrees and branches: Git.
- Pull requests and reviews: the configured review provider.
- Workspace configuration: `~/.pi/agent/wayfinder/settings.json`.
- Agent/session associations: `~/.pi/agent/wayfinder/state.json`.
- Stale-while-revalidate tracker cache: `~/.pi/agent/wayfinder/cache/`.
- Repository process heartbeats: `~/.pi/agent/wayfinder/heartbeats/`.

The local files are versioned JSON, written atomically with private permissions, and loaded on every new Pi session. The cockpit opens from cache immediately and refreshes tracker data in the background. Credentials remain in provider CLIs and environment variables.

## Navigation

- `↑/↓`, `Enter`, `Esc`: select, open, and return.
- `1`–`3`: switch map layout.
- `c`: complete map context.
- `g`: repository activity (ready work, moving agents, input needed, results, failures, and resolved work).
- `s`: settings.
- `n`: start an agent from a selected ticket.
- `j`: jump to or take over the linked agent.
- `x`: cancel a running linked agent.
- `r`: retry on-demand comments and dependency hydration from a ticket document.

Context documents scroll with `↑/↓` and `PgUp/PgDn`. Inside settings value editors, `←/→` cycles capability-valid values.

## Agent behavior

Starting a ticket shows the resolved runtime/model/effort/profile and working directory, then asks for confirmation. An unclaimed GitHub ticket is claimed before spawn, preserving Wayfinder's claim-first rule. HITL tickets open takeover immediately; AFK tickets continue in the background and appear in Agent activity.

Active sessions use the shared subagent host. Session identifiers and transcript paths are persisted so settled runs remain visible after restarting Pi. Open cockpits poll repository state, and private process heartbeats distinguish agents owned by a live Pi process from interrupted runs. Active sessions can be taken over by their owning Pi process; spectator processes stay read-only rather than creating concurrent session writers. Archived Pi sessions can be opened directly from the slash-command context. Other archived runtimes expose their transcript path and can be continued from the ticket.

The production adapters are Jira, GitHub Issues, and local Markdown. The Jira adapter uses the official Atlassian CLI (`acli`) in read-only mode. Jira epics are map roots and their children are tickets; statuses, assignees, labels, and blocking links feed the cockpit. By default it loads active epics with `issuetype = Epic AND statusCategory != Done ORDER BY updated DESC`. Set `WAYFINDER_JIRA_MAP_JQL` to restrict map roots to the Jira project, team, label, or hierarchy used by a workspace. Install and authenticate ACLI separately with `acli jira auth login` before selecting Jira in Wayfinder settings.

A GitHub map root is discovered from either the repository's `epic` label or the Wayfinder-specific `wayfinder:map` label; both use native sub-issues, so existing epics do not need relabelling. Root summaries are refreshed in parallel; full comments and dependency edges hydrate only when a ticket opens. The loader also follows explicit migration markers: a GitHub map or ticket that names another source of truth is shown as a read-only `MOVED` mirror.

When GitHub tracker instructions are absent but the repository contains `map.md` or `wayfinder.md`, Wayfinder automatically uses the Markdown adapter. Each map owns an adjacent `issues/` directory. Discovery ignores `.claude/` so linked worktree copies do not appear as duplicate maps. Issue files support `Type:`, `Status:`, `Blocked by:`, and optional `Mode:` fields plus normal Markdown sections such as `## Question` and `## Answer`. Resolved issue dependencies no longer block downstream frontier work. Markdown remains canonical; opening or running an agent does not silently rewrite the files. Other tracker types remain capability previews until their adapters are installed.
