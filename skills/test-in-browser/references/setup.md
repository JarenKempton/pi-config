# Setup and repair

## Prerequisites

- Node.js 22 or newer
- A Chromium-family browser that exposes `DevToolsActivePort`
- Remote debugging enabled from `chrome://inspect/#remote-debugging`
- The intended browser profile open and authenticated

The launcher currently pins `@playwright/mcp` to `0.0.78`. Update the pin deliberately and re-run validation before committing an upgrade.

## Bootstrap another machine

After installing the GitHub-backed Pi configuration, run:

```bash
node ~/.pi/agent/pi-config/bin/setup-browser-tools.mjs --apply
```

The bootstrap performs only these changes:

- replaces `pi-agent-browser-native` with `pi-mcp-adapter` in Pi's user settings;
- links Pi's MCP configuration to the repository-owned `mcp.json`;
- links this skill into Codex and Claude skill directories;
- installs a per-user service that keeps one loopback-only Playwright MCP broker attached;
- registers `http://localhost:8931/mcp` as `authenticated-browser` in Pi, Codex, and Claude.

Run without `--apply` to preview the plan.

## Session lifecycle

The broker is intentionally long-lived. Pi, Codex, and Claude connect to that one local service rather than opening separate CDP connections, so Helium does not ask for control permission every time the harness changes. After the browser or broker restarts, Chromium may show one **Allow remote debugging?** prompt. Approve that local broker once; normal website login, SSO, and MFA remain a user handoff.

The wrapper watches for a changed `DevToolsActivePort` endpoint and restarts the broker automatically after the browser restarts. Agents must still discard stale element references and take a fresh snapshot.

On macOS the bootstrap installs `~/Library/LaunchAgents/com.jaren.authenticated-browser.plist`. On Linux it installs a user systemd service named `authenticated-browser.service`. The service runs only on loopback and is not exposed to the LAN or tailnet.

## Endpoint selection

The launcher scans live `DevToolsActivePort` files for Helium, Chrome, Chromium, Brave, and Edge. It never prints the WebSocket endpoint when running `status`.

Optional environment overrides:

- `BROWSER_CDP_ENDPOINT`: exact CDP WebSocket or HTTP endpoint.
- `BROWSER_CDP_ACTIVE_PORT_FILE`: exact `DevToolsActivePort` file.
- `BROWSER_USER_DATA_DIR`: one browser user-data directory.
- `BROWSER_USER_DATA_DIRS`: platform-delimited list of user-data directories.
- `BROWSER_PROFILE_HINT`: text that must be preferred in the endpoint file path.
- `BROWSER_MCP_PORT`: local broker port; defaults to `8931` and must match harness configuration.

## Diagnostics

```bash
node ~/.pi/agent/pi-config/skills/test-in-browser/scripts/browser-cdp.mjs status
codex mcp get authenticated-browser --json
claude mcp get authenticated-browser
```

If no endpoint is found, open the intended browser profile and toggle remote debugging off and on. Do not hard-code the displayed random port.
