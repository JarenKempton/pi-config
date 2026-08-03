# Local patches

Local safety/integration patches applied on top of upstream commit `21f40f41fb98e088281a6fcd512388d82bddf911`:

- Added subagent safety profiles: `scout`, `researcher`, `worker`, `unrestricted`; default is `scout`.
- Reject non-unrestricted child working directories outside the parent project.
- Require explicit UI confirmation for each unrestricted subagent/workflow spawn and each unrestricted workflow child; reject unrestricted headless/background launches.
- Mapped Claude/Codex/Pi backend permissions by profile, preserving the old full-permission bypass only for confirmed unrestricted spawns.
- Added explicit tool allowlists for every restrictive profile. Pi workers have runtime-wrapped `write`/`edit` tools with lexical, realpath, and symlink-escape checks and no shell tool; workflow children use the same policy.
- Prevented restrictive Claude profiles from inheriting filesystem settings that could widen permissions; Claude workers require sandboxing and forbid unsandboxed commands.
- Disabled inherited Codex MCP servers and web search for restrictive profiles; only the researcher profile enables live web search, while confirmed unrestricted runs retain normal user configuration.
- Display profile in subagent snapshots/lists/TUI.
- Made workflow artifacts private (`0700` dirs, `0600` files) and added bounded 30-day startup cleanup.
- Kept Davis gradient header/footer, but removed private TUI child traversal/theme-section hiding.
- Replaced `/lg` custom diff TUI with `hunk diff --watch` opened in macOS Terminal at the exact session cwd; `/pr` is preserved.
- Added root Pi package manifest and dependency metadata so only selected Davis entries are loaded from `vendor/davis`.
- Added a restricted host bridge for user-initiated Wayfinder agents. These runs reuse the shared manager, permission profiles, concurrency cap, and takeover UI; they do not inject completion messages into the parent model transcript. The bridge accepts the common extension context so both `/wayfinder` and its global shortcuts can open and control active runs; archived session switching remains command-context-only.
- Changed the subagent dashboard and takeover from full-terminal overlays to bounded centered modals, and added `Alt+S` as the same mid-run entry point as `/subagents`.
- Normalized cumulative subagent cost across Pi (recorded message cost), Claude (SDK result cost), and Codex (model-catalog API-equivalent estimate), then published the current-session subagent subtotal to the footer. Unknown rates remain explicit lower bounds.
- Added explicit takeover handoffs: `c` copies the latest answer, `Shift+C` copies a reasoning-safe Markdown transcript, and `q` queues a BTW answer into the parent. A completed read-only BTW can spawn a fresh project-confined worker only after separate work-contract and executioner approvals.
- Tightened the footer dashboard: repository details sit beside the cwd, costs use two decimals, and throughput/window-size noise is removed. Quotas use clear provider labels with percentage and reset countdown, stack providers vertically to preserve horizontal space, and share the same green/warning/error thresholds as context usage. Stale Claude data remains visible as a muted, explicitly stale percentage summary without misleading reset times; expired current data and model-specific Codex buckets stay hidden. Each canonical Codex window is shown independently, so weekly usage remains visible even when no 5-hour window exists.
