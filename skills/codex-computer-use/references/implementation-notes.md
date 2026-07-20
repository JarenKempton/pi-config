# Implementation notes

## Verified local behavior

Tested July 20, 2026 with:

- ChatGPT-bundled `codex-cli 0.145.0-alpha.18`
- OpenAI bundled `computer-use` plugin `1.0.1000451`
- macOS native Computer Use service

Observed behavior:

1. `codex exec` can load `node_repl` and call `sky.list_apps()`.
2. `codex exec` cannot complete native app access. `sky.get_app_state()` reports `Computer Use was not approved`.
3. Enabling the direct `computer-use` MCP for `codex exec` exposes `click`, `drag`, `get_app_state`, `list_apps`, `perform_secondary_action`, `press_key`, `scroll`, `select_text`, `set_value`, and `type_text`.
4. The direct MCP emits `mcpServer/elicitation/request` with a message such as `Allow ChatGPT to use System Settings?`.
5. The stock noninteractive `codex exec` client denies that elicitation even when granular `mcp_elicitations` are enabled.
6. A client of `codex app-server` can receive the elicitation and respond with `{ "action": "accept" }`. The Computer Use call then succeeds and returns accessibility text plus an embedded image.

The wrapper uses the sixth path. It does not persist approvals: the MCP request advertises optional `_meta.persist: ["always"]`, but the wrapper never sends persistence metadata.

## Primary sources

- OpenAI Codex protocol source defines `AskForApproval::Granular`, including `mcp_elicitations`, and `Op::ResolveElicitation`: <https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs>
- OpenAI Computer Use API guide distinguishes the model tool loop from a local desktop harness: <https://developers.openai.com/api/docs/guides/tools-computer-use>
- Local first-party plugin manifest describes native macOS control: `~/.codex/plugins/cache/openai-bundled/computer-use/*/.codex-plugin/plugin.json`
- Local first-party skill documents the `sky` native API and confirmation policy: `~/.codex/plugins/cache/openai-bundled/computer-use/*/skills/computer-use/SKILL.md`
- Codex app-server’s generated protocol schema includes `initialize`, `thread/start`, `turn/start`, and `mcpServer/elicitation/request`. Generate the installed version with:

  ```bash
  codex app-server generate-json-schema --experimental --out /tmp/codex-app-server-schema
  ```

## Design constraints

- Native app control is inherently stateful and shares the physical desktop. Calls must be serialized.
- The OpenAI-signed Codex process must launch `SkyComputerUseClient`; launching it directly from an arbitrary Python parent fails sender authentication.
- App names are approved explicitly per invocation. Unknown app requests are declined.
- Screenshots arrive as base64 MCP image content and are decoded into the invocation output directory.
- The wrapper intentionally uses ephemeral Codex threads and a read-only filesystem sandbox. This does not prevent UI side effects, so Codex’s Computer Use policy and the caller’s prompt remain essential.
