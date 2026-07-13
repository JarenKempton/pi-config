---
name: test-in-browser
description: Test, reproduce, inspect, or verify user-facing web behavior in the user's existing authenticated browser session. Use automatically after UI-facing changes, for browser QA and end-to-end verification, when reproducing web bugs, inspecting console or network failures, validating dashboards and forms, taking browser evidence, or whenever correctness depends on visible browser behavior. Reuse the running debug-enabled Chromium session; do not launch a separate headless browser or manage authentication silently.
---

# Test in Browser

Use the configured `authenticated-browser` Playwright MCP server. A loopback-only broker keeps one browser attachment alive and shares it across harnesses, preserving the browser's cookies, tabs, extensions, and login state.

## Workflow

1. Read the repository's `AGENTS.md` and any project-specific browser guidance first.
2. Run `node ~/.pi/agent/pi-config/skills/test-in-browser/scripts/browser-cdp.mjs status` when broker health is uncertain.
3. Attach through `authenticated-browser`. Never print, paste, persist, or expose the resolved WebSocket endpoint.
4. Select an existing relevant tab when one exists; otherwise open the requested URL in the attached browser.
5. Capture an initial snapshot before using element references.
6. Perform the smallest actions needed to reproduce or verify the requested behavior.
7. Inspect console errors and failed network requests when behavior is unexpected.
8. Capture evidence proportional to the task: final snapshot, screenshot, relevant console/network failures, and exact observed result.
9. Report what was actually exercised. Do not claim browser verification from code inspection alone.

## Authentication handoff

Treat a redirect or visible transition to login, sign-in, SSO, OAuth, MFA, CAPTCHA, account selection, or access-denied UI as `AUTH_REQUIRED` unless the user explicitly asked to test that authentication flow.

When authentication is required:

1. Leave the headed browser on the authentication screen.
2. Ask the user to authenticate and say when it is ready.
3. Do not request, read, type, store, or transmit passwords, passkeys, recovery codes, or one-time codes.
4. After handoff, take a fresh snapshot and continue the original loop from the same browser session.

Do not fall back to a new browser, copied profile, exported cookies, or `storageState` merely to avoid the handoff.

## Safety

- Treat the browser profile as sensitive because attached tools can access authenticated pages and browser storage.
- Keep the debugging listener on loopback. Do not expose CDP or Playwright MCP to a LAN, tailnet, or public interface without a separate secured design.
- Do not clear cookies, local storage, cache, permissions, or tabs unless the user explicitly asks.
- Before actions with meaningful external impact, follow the active harness's confirmation policy. Browsing and read-only inspection do not imply permission to submit, publish, delete, purchase, deploy, or alter cloud configuration.
- If the target appears to be production and the task could mutate data, stop and confirm the intended scope.
- Serialize use of the shared browser. If another agent is actively controlling it, wait or report the contention.

## Recovery

- If no live endpoint exists, ask the user to open the intended Chromium browser/profile and enable `chrome://inspect/#remote-debugging`.
- If `brokerAvailable` is false, restart the installed user service. Chromium may show one full-control authorization prompt after either the browser or broker restarts; leave that prompt visible and ask the user to allow the trusted local broker.
- If multiple browser data directories are active, set `BROWSER_PROFILE_HINT` to part of the desired `DevToolsActivePort` path.
- If attachment dies, rerun `status`, reconnect, take a fresh snapshot, and discard stale element references.
- If a page is visually present but inaccessible through DOM or accessibility data, use Playwright screenshots and coordinate-capable vision tools only as a fallback.

Read [setup.md](references/setup.md) only when installing, repairing, or moving this setup to another machine. Read [project-guidance.md](references/project-guidance.md) when adding repository-specific browser rules.
