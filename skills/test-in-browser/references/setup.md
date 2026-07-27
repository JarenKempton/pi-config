# Browser setup and repair

## Default path

`browser_qa` uses the existing Codex Computer Use wrapper in `skills/codex-computer-use/`. It needs:

- macOS;
- an authenticated Codex installation with the bundled Computer Use plugin;
- the visible Helium browser already running.

It does not require remote debugging or Playwright authorization.

## Optional Playwright diagnostics

The `authenticated-browser` MCP remains available for DOM, console, network, and trace inspection. It uses a loopback broker at `http://localhost:8931/mcp` and a debug-enabled Chromium-family browser.

Diagnostics:

```bash
node ~/.pi/agent/pi-config/skills/test-in-browser/scripts/browser-cdp.mjs status
codex mcp get authenticated-browser --json
claude mcp get authenticated-browser
```

An open broker port does not prove Playwright can attach. Playwright auto-attaches every open page, so one CDP-unresponsive tab can block initialization. Do not repeatedly retry or ask the user to approve the same failing connection; use `browser_qa` instead.

The repository bootstrap is:

```bash
node ~/.pi/agent/pi-config/bin/setup-browser-tools.mjs --apply
```

It mutates user services and harness configuration, so preview it without `--apply` and obtain explicit approval before applying it.
