# Compatibility

Researched: 2026-08-30/31 (live probes + official documentation).

## Method

Primary sources, in order of authority:

1. **Local ground truth**: the installed `codex-cli 0.145.0` was probed
   directly; its official app-server protocol schemas were generated with
   `codex app-server generate-json-schema` and the adapter's method names,
   payload shapes, sandbox enums, and approval requests match them.
2. **Official documentation**: cursor.com/docs (CLI overview, using, headless,
   output-format, plugins reference), agentclientprotocol.com behavior as
   documented by Cursor's `agent acp` page.
3. **npm registry**: `@openai/codex`, `cursor-agent` (1.0.3), `@cursor/sdk`
   (1.0.30) package metadata.
4. **Official repositories**: `openai/codex-plugin-cc` (Apache-2.0, inspected
   for architecture only — no source reused), local OpenAI Codex plugin
   manifests (`.codex-plugin/plugin.json`) as schema reference.

Consulted pages/repos (accessed 2026-08-30/31):

- https://cursor.com/docs/cli/overview
- https://cursor.com/docs/cli/using
- https://cursor.com/docs/cli/headless
- https://cursor.com/docs/cli/reference/output-format
- https://cursor.com/docs/plugins
- https://cursor.com/docs/reference/plugins
- https://www.npmjs.com/package/@cursor/sdk (v1.0.30)
- https://www.npmjs.com/package/cursor-agent (v1.0.3)
- `codex --help`, `codex exec --help`, `codex app-server --help`,
  `codex login --help`, `codex plugin --help` (codex-cli 0.145.0)
- `codex app-server generate-json-schema` output (codex_app_server_protocol
  v1/v2 schemas)
- https://github.com/openai/codex-plugin-cc (manifest/commands structure; MIT/Apache-2.0 headers inspected)

## Minimum supported versions

| Component                   | Minimum                                                   | Tested                                          |
| --------------------------- | --------------------------------------------------------- | ----------------------------------------------- |
| Node.js                     | 20.19.0                                                   | 20.20.2 (macOS 15, x64)                         |
| npm                         | 10                                                        | 10.8.2                                          |
| git                         | 2.30 (worktrees, `--initial-branch`)                      | 2.53.0                                          |
| Codex CLI                   | 0.145.0 (app-server protocol v1/v2, `thread/*`, `turn/*`) | 0.145.0                                         |
| Cursor CLI (`cursor-agent`) | 1.0.x (`acp` subcommand, `--print`, `--output-format`)    | **not installed locally — untested end-to-end** |
| `@cursor/sdk`               | 1.0.x                                                     | **not installed locally — untested end-to-end** |

## Supported operating systems

| OS      | Status                                                                         |
| ------- | ------------------------------------------------------------------------------ |
| macOS   | tested (development machine)                                                   |
| Linux   | CI-tested; process-group cancellation via `kill(-pid)`                         |
| Windows | CI-tested; `taskkill /PID <pid> /T /F` tree cancellation; PowerShell installer |

## Authentication requirements

| Feature                   | Requires                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| Cursor → Codex delegation | Codex login (`codex login` or `OPENAI_API_KEY` via `codex login --with-api-key`)            |
| Codex → Cursor via ACP    | Official Cursor CLI installed (binary `agent`) + `agent login` (existing local Cursor auth) |
| Codex → Cursor via SDK    | `@cursor/sdk` installed + `CURSOR_API_KEY` (Cursor cloud agents; billing per Cursor's docs) |
| Cursor `--print` fallback | Cursor CLI + explicit `allowNonInteractiveCliFallback: true`                                |

`CURSOR_API_KEY` and `OPENAI_API_KEY` are never read, stored, or logged by the
bridge; the underlying CLIs/SDKs consume them from the environment.

## Verified session-resume behavior

- **Codex**: `thread/resume { threadId }` continues a recorded thread on a new
  app-server connection (schema-verified; threads persist under
  `~/.codex/sessions`). The bridge's `codex_reply` uses it. `codex exec`
  sessions are one-shot; the result's `continuation.how` says so and points at
  `codex exec resume <id>` for manual continuation.
- **Cursor ACP**: sessions live for the CLI process; `cursor_reply` re-attaches
  with `session/load` when the agent advertises support, else it starts a new
  session and says so. `cursor-agent --resume <id>` is the documented native
  resume path for CLI sessions.
- **Cursor SDK**: follow-ups use the agent id when the installed SDK supports
  attaching to an existing agent; the adapter fails with
  `ADAPTER_UNSUPPORTED_CAPABILITY` (and selection falls back to ACP) when it
  does not.

**Cursor CLI naming correction (2026-08-31):** earlier revisions of this
project said `npm i -g cursor-agent`. That package is third-party and
unrelated to Cursor/Anysphere. The official CLI ships via the installer
script only, with binary name `agent`; the bridge resolves `agent` first and
accepts `cursor-agent` only as a legacy alias. Verified against
cursor.com/docs/cli/installation and the npm registry.

Honest limitation: we do **not** claim that native Codex threads or Cursor
sessions appear in any specific desktop/editor history UI. Resume is provided
through the bridge (`*_reply`) and the vendors' CLIs.

## Deviations and open differences (spec vs. current official docs)

1. The task specification's conceptual MCP tool names (`codex_start`, …) match
   what we ship; the specification's `codex app-server` method names
   (`newThread`, `sendUserTurn`, `codex/event/*`) are **renamed upstream**:
   current 0.145.0 uses `thread/start`, `turn/start`, and `item/*` /
   `thread/*` notifications. We follow the current protocol and record the
   deviation here.
2. The deprecated `codex mcp-server` is not used anywhere (it still exists in
   0.145.0 but the app-server is the supported programmatic surface).
3. Cursor plugin commands (`commands/*.md`) surface in the IDE; per Cursor's
   docs the CLI (`cursor-agent`) currently surfaces skills but not plugin
   commands — the skills carry the same instructions so behavior is identical
   in both surfaces.
4. `codex exec --json` event shapes (`msg.type: thread_started`,
   `agent_message`, …) are parsed defensively; if a future Codex renames
   them, the fallback degrades to "no events" without failing the job.

## Capability matrix

| Capability             | codex app-server                | codex exec         | cursor-sdk     | cursor acp              | cursor print      |
| ---------------------- | ------------------------------- | ------------------ | -------------- | ----------------------- | ----------------- |
| Native id preserved    | thread (UUIDv7)                 | session id         | agent id       | session id              | session id        |
| Live continuation      | yes (`codex_reply`)             | no (manual resume) | yes (followUp) | yes (session/load)      | via `--resume`    |
| Structured events      | yes (item/\*)                   | yes (--json)       | yes (events)   | yes (session/update)    | yes (stream-json) |
| Approval handling      | relayed→auto-denied             | none               | none           | relayed→denied          | none              |
| Sandbox honors profile | yes (read-only/workspace-write) | yes (`--sandbox`)  | per API        | via permission requests | no (full access)  |
| Network default        | denied                          | denied             | n/a (cloud)    | per CLI                 | per CLI           |
