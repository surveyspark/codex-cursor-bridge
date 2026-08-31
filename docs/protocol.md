# Protocol Notes

Concrete wire-level details for the transports the bridge speaks, recorded
from official schemas/docs (see compatibility.md for dates and sources). Use
this when debugging with `--debug` or writing a new adapter.

## Codex app-server (primary Codex transport)

Spawn: `codex app-server` (stdio, NDJSON, JSON-RPC 2.0).

Handshake:

```json
→ {"jsonrpc":"2.0","id":1,"method":"initialize",
   "params":{"clientInfo":{"name":"codex-cursor-bridge","title":"codex-cursor-bridge","version":"0.1.0"}}}
← {"jsonrpc":"2.0","id":1,"result":{"codexHome":"…","platformFamily":"unix","platformOs":"macos","userAgent":"…"}}
→ {"jsonrpc":"2.0","method":"initialized"}
```

Thread + turn:

```json
→ {"jsonrpc":"2.0","id":2,"method":"thread/start",
   "params":{"cwd":"/repo","sandbox":"read-only","approvalPolicy":"never"}}
← {"jsonrpc":"2.0","id":2,"result":{"thread":{"id":"<uuidv7>","sessionId":"…"},…}}
← {"jsonrpc":"2.0","method":"thread/started","params":{"thread":{"id":"…"}}}

→ {"jsonrpc":"2.0","id":3,"method":"turn/start",
   "params":{"threadId":"<id>","input":[{"type":"text","text":"<task>"}],
             "sandboxPolicy":{"type":"readOnly","networkAccess":false},
             "model":"<optional>","effort":"<optional>"}}
← turn/started → item/started → item/completed* → thread/tokenUsage/updated
← turn/completed → {"jsonrpc":"2.0","id":3,"result":{…}}
```

Item kinds on `item/completed`: `agentMessage` (final text),
`commandExecution` (`command`, `exitCode`, `aggregatedOutput`), `fileChange`
(`changes[]`), `plan`, `reasoning`, `mcpToolCall`, `webSearch`, `error`.

Cancellation: `turn/interrupt { threadId, turnId }` (fire-and-forget during
teardown), then process-group kill.

Follow-up: `thread/resume { threadId }` then another `turn/start`.

Server→client requests (the bridge auto-denies these):
`execCommandApproval`, `applyPatchApproval`,
`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`.

Sandbox enums (verified from 0.145.0 schemas):

- `sandbox` (thread/start): `"read-only" | "workspace-write" | "danger-full-access"`
- `sandboxPolicy` (turn/start): `{"type":"readOnly","networkAccess":bool}` |
  `{"type":"workspaceWrite","networkAccess":bool,"writableRoots":[…],"excludeSlashTmp":bool,"excludeTmpdirEnvVar":bool}` |
  `{"type":"dangerFullAccess"}`
- `approvalPolicy`: `"untrusted" | "on-request" | "never"` (bridge: `"never"`)

Unknown notifications are ignored (forward compatibility); malformed JSON
lines are logged and skipped; oversized lines (>16 MiB) trigger
`codex.oversized-message` events.

## codex exec (one-shot fallback)

```
codex exec --json --sandbox <mode> --skip-git-repo-check -C <cwd> [-m <model>]
```

- Prompt via stdin (never argv).
- NDJSON events with `msg.type`: `thread_started`/`session_configured`
  (session id), `agent_message` (final message), `exec_command_begin/end`,
  `patch_apply_end`. Parsing is defensive; unknown shapes are ignored.
- One-shot only: `continuation.supported=false`, `how` points at
  `codex exec resume <id>`.

## Cursor ACP

Spawn: `cursor-agent acp` (stdio, JSON-RPC 2.0, Agent Client Protocol).

```json
→ {"jsonrpc":"2.0","id":1,"method":"initialize",
   "params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false}}}}
← {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true}}}
→ {"jsonrpc":"2.0","method":"initialized"}
→ {"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/repo","mcpServers":[]}}
← {"jsonrpc":"2.0","id":2,"result":{"sessionId":"…"}}
→ {"jsonrpc":"2.0","id":3,"method":"session/prompt",
   "params":{"sessionId":"…","prompt":[{"type":"text","text":"<task>"}]}}
← {"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"…","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"…"}}}}
← {"jsonrpc":"2.0","method":"session/update","params":{…,"update":{"sessionUpdate":"tool_call","title":"…"}}}
← {"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}
```

- Permission requests arrive as server→client `session/request_permission`;
  the bridge selects the `reject_once`-kind option (deny) and records the
  decision. It never auto-approves.
- `session/cancel { sessionId }` on abort; the process tree is killed after.
- Continuation: `session/load { sessionId, cwd, mcpServers: [] }` when the
  agent advertises `loadSession`; otherwise a fresh session is created and
  the result says continuation is via `cursor-agent --resume <id>`.

## Cursor CLI fallback

```
cursor-agent --print --output-format stream-json --verbose   # prompt via stdin
```

Final `result` event: `{ type, subtype, is_error, result, session_id,
duration_ms }`. On failure the CLI prints no JSON (stderr only, per official
docs) — the bridge surfaces stderr lines as debug events and reports
`CHILD_EXITED`. Gated behind `allowNonInteractiveCliFallback` because
non-interactive mode has full write access.

## Cursor SDK (`@cursor/sdk`)

Imported dynamically (optional peer). Constructor surface used:
`new Agent({ prompt: { text }, workingDirectory })`, then `waitFor()` /
`done`, `id`, `text`, `followUp(message)`, `stop()`. All calls are
capability-checked; mismatches raise `ADAPTER_UNSUPPORTED_CAPABILITY` and the
selector falls back to ACP. The SDK reads `CURSOR_API_KEY` from the
environment itself; the bridge never touches the value.

## MCP server (bridge ↔ hosts)

JSON-RPC 2.0 over stdio (NDJSON). Implemented methods: `initialize`,
`notifications/initialized`, `ping`, `tools/list`, `tools/call`. Tool results
return `{ content: [summary text, fenced JSON], structuredContent }`; errors
return `isError: true` with a redacted `ERROR <CODE>: <message>` text. stdout
carries protocol only — logs go to stderr/state files.
