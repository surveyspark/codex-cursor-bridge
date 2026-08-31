# CODEX INTEGRATION RESEARCH REPORT (researched 2026-08-30)

**Scope:** Official OpenAI Codex CLI integration surfaces for interoperability. Local machine runs codex-cli **0.145.0**; all flag surfaces were verified against the installed binary (`codex … --help`) plus a live `codex exec --json` run on 2026-08-30. Protocol facts come from the official docs and the open-source repo at the state of research day (repo `main`, latest stable npm **0.151.0**, latest tag `rust-v0.152.0-alpha.4`).

**Official sources used** (only these, plus npm registry):

- developers.openai.com/codex/_ (server-rendered markdown at `…/codex/<page>.md` — pages state: "Markdown versions of documentation pages are available by appending `.md` to the page URL"); equivalent host `learn.chatgpt.com/docs/_`
- github.com/openai/codex (README, `docs/` folder, `codex-rs/` crates, GitHub Releases API, GitHub issue #2288)
- github.com/openai/codex-plugin-cc (full repo tree + source files)
- npmjs registry API for `@openai/codex`

> Note: developers.openai.com/codex pages currently 301 → `learn.chatgpt.com/docs/…` (titled "ChatGPT Learn"). Both hosts serve the identical Codex docs; URLs below use the developers.openai.com form.

---

## 1. Package, install, binary architecture, 0.145.x changelog

- **npm package:** `@openai/codex`. Dist-tag `latest` = **0.151.0** (published 2026-08-29T09:59:26Z). 4,183 published versions total (platform-specific builds are published as separate versions like `0.151.0-darwin-arm64`; alpha line currently `0.152.0-alpha.4`). Source: https://registry.npmjs.org/@openai/codex
- **Install:** `npm install -g @openai/codex` (documented in codex-plugin-cc README and repo install docs, https://github.com/openai/codex/blob/main/docs/install.md → https://developers.openai.com/codex/install).
- **Architecture: thin node wrapper around a native Rust binary.** The npm package's `bin` is `bin/codex.js` (node ≥16 engine), with **optionalDependencies** `@openai/codex-{darwin,linux,win32}-{x64,arm64}` shipping the prebuilt Rust binaries; latest version has no runtime `dependencies`. Verified in the registry metadata for 0.151.0. The Rust implementation lives in the `codex-rs/` workspace of https://github.com/openai/codex.
- **0.145.0** released 2026-07-21 (`rust-v0.145.0`). Highlights (full notes: https://github.com/openai/codex/releases/tag/rust-v0.145.0):
  - _Experimental paginated thread history_ with efficient resume, search, persisted names, sub-agent support, and memories (PRs #33364, #33907, #34085, #34229, #34386).
  - `/import` migrates Cursor and Claude Code settings, MCP servers, plugins, sessions, commands, project memories.
  - Audio inputs/tool outputs + streaming realtime V3; stabilized multi-agent V2 (sub-agent models, reasoning levels, concurrency, roles).
  - Amazon Bedrock login/custom endpoints (experimental); inline clickable visualization links.
  - Fixes: contextual branch on prompt-edit/retry; TUI incremental markdown rendering; MCP startup timeouts/serialized refreshes; Windows native exec-server sandbox + network proxy enforcement; forced-`rm` detection and consistent full-access confirmation.
  - `codex exec resume` and app-server existed before 0.145 (present in the 0.145.0 binary — verified via local `--help`); 0.145's contribution is the paginated-history/experimental layer behind them (`historyMode: "paginated"` is rejected with `-32601` for now per current app-server docs).
- **0.151.0** (2026-08-29): MCP tool-result interception by extensions, plugin catalog combining, restored permission profiles across TUI turns, structured MCP errors preserved in app-server responses. (https://github.com/openai/codex/releases/tag/rust-v0.151.0)

## 2. `codex exec` — non-interactive mode

Primary docs: https://developers.openai.com/codex/noninteractive (md) and CLI reference https://developers.openai.com/codex/cli/reference (md). Flags below verified with `codex exec --help` on the local **0.145.0** binary.

**Exact flags (0.145.0 `codex exec --help`):**

- `[PROMPT]` positional; **if omitted or `-`, the prompt is read from stdin**; "If stdin is piped and a prompt is also provided, stdin is appended as a `<stdin>` block."
- `--json` — "Print events to stdout as JSONL"
- `-o, --output-last-message <FILE>` — writes the last agent message to file (docs: it also still prints to stdout)
- `-s, --sandbox <read-only|workspace-write|danger-full-access>`
- `--dangerously-bypass-approvals-and-sandbox` (explicit escape hatch in 0.145.0 help; "EXTREMELY DANGEROUS… externally sandboxed" environments only)
- `-C, --cd <DIR>`; `--add-dir <DIR>` (extra writable dirs)
- `-m, --model <MODEL>`; `--oss` / `--local-provider <lmstudio|ollama>`; `-p, --profile <NAME>` (layers `$CODEX_HOME/<name>.config.toml`)
- `-c, --config <key=value>` (dotted path; value parsed as TOML, else literal; e.g. `-c model="o3"`, `-c shell_environment_policy.inherit=all`)
- `--enable <FEATURE>` / `--disable <FEATURE>` (repeatable; = `-c features.<name>=true|false`), `--strict-config` (error on unrecognized config keys)
- `-i, --image <FILE>...`; `--output-schema <FILE>` (JSON Schema for final response)
- `--skip-git-repo-check`; `--ephemeral` (no rollout persistence); `--ignore-user-config` (skip `config.toml`); `--ignore-rules` (skip execpolicy `.rules`); `--color <always|never|auto>`
- **`--full-auto`: NOT in the 0.145.0 help.** Current docs say "Codex keeps `codex exec --full-auto` as a deprecated compatibility flag and prints a warning. Prefer the explicit `--sandbox workspace-write`." (https://developers.openai.com/codex/noninteractive) — i.e. hidden/deprecated; do not use in new integrations. Similarly `-a/--ask-for-approval` is not offered on `exec` in 0.145.0 (it exists on `codex resume`/TUI); exec is effectively non-interactive.
- **`--experimental-json` still accepted in 0.145.0** (verified: `codex exec --experimental-json --help` exits 0). History: openai/codex issue #2288 — maintainer: "try `codex exec --experimental-json` (will soon become the default `--json` behavior)". Current docs only document `--json`. **Use `--json`.**
- Subcommands: `codex exec resume`, `codex exec review`, `codex exec help`.

**Default behavior (docs):** progress streams to **stderr**, final agent message to **stdout**; default sandbox is **read-only**; requires a Git repo unless `--skip-git-repo-check`; if a configured MCP server has `required = true` and fails to init, exec exits with an error.

**JSONL event schema** (documented at https://developers.openai.com/codex/noninteractive, sample verified live on 0.145.0):

```jsonl
{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Repo contains docs, sdk, and examples directories."}}
{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":0}}
```

- Event types: `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.started`, `item.completed`, `error` (docs).
- Item types (docs): "agent messages, reasoning, command executions, file changes, MCP tool calls, web searches, and plan updates." Wire names observed/documented: `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `plan_update`, and `error` (an `error` **item** with `message` also appears mid-stream; live-observed on 0.145.0 for a non-fatal skills-budget warning).
- `turn.completed` carries `usage` with `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens` (0.145.0 live-observed), `output_tokens`, `reasoning_output_tokens`. Cache-write key is **not** in the docs example — treat as version-dependent.
- **Exit codes:** success = `0` (live-verified). A documented special case: required-MCP-init failure → error exit. Otherwise a complete machine-readable exit-code table is **not officially documented** — rely on `turn.failed`/`error` events + process status.
- Structured output: `--output-schema schema.json -o out.json` makes the final response conform to a JSON Schema (docs example extracts `project_name`, `programming_languages`).
- CI: prefer the official GitHub Action `openai/codex-action` (starts a Responses API proxy so the key is never exposed to repo-controlled code). Auth env for exec: `CODEX_API_KEY` (docs warn against `OPENAI_API_KEY` in job-level env on repo-controlled workflows).

## 3. `codex resume` / `codex exec resume` — sessions & rollout files

- **Rollout files:** `~/.codex/sessions/YYYY/MM/DD/rollout-<UTC-timestamp>-<uuid>.jsonl`. Verified on the local machine (e.g. `~/.codex/sessions/2026/06/25/rollout-2026-06-25T05-58-03-019efc2d-3c36-7b20-aa64-0d9669702733.jsonl`). App-server docs call these "thread logs"/"session rollout" files; `thread/archive` "moves the thread's persisted JSONL log into the archived directory" and `thread/unarchive` "restores an archived thread rollout back into the active sessions directory" (https://developers.openai.com/codex/app-server) — i.e. app-server threads and CLI sessions share this persisted store.
- **`codex resume [SESSION_ID] [PROMPT]`** (interactive TUI; 0.145.0 help): SESSION_ID = "Session id (UUID) or session name. UUIDs take precedence if it parses." `--last` = most recent recorded session; `--all` disables cwd filtering; `--include-non-interactive` adds non-interactive (exec) sessions to the picker; plus `-m`, `-s`, `-C`, `-c`, `-a/--ask-for-approval <untrusted|on-request|never>`, `--search`, `--remote <ws|wss|unix>` (attach TUI to a remote app-server).
- **`codex exec resume [SESSION_ID] [PROMPT]`** (0.145.0 help): "Conversation/session id (UUID) or thread name"; `--last` = "Resume the most recent recorded session (newest)"; `--all`; same output flags as exec (`--json`, `-o`, `--output-schema`, `--ephemeral`, `--skip-git-repo-check`, `-c`, `-m`, images).
- Docs: "use the `resume` subcommand… `codex exec resume --last "fix the race conditions you found"`; you can also target a specific session ID with `codex exec resume <SESSION_ID>`" (https://developers.openai.com/codex/noninteractive). "`codex resume` scopes `--last` to the current working directory unless you pass `--all`" and cwd mismatch prompts (configurable `tui.resume_cwd = "current"|"session"`) (https://developers.openai.com/codex/cli/reference).
- **THREAD vs SESSION id semantics (app-server):** `thread/resume` takes `threadId`; the returned thread object contains **both** `id` and `sessionId`: "`thread.sessionId` identifies the current live session tree root. Root threads use their own thread id as the session id; forked threads keep the session id of the root they came from. Clients should read the session id from `thread.sessionId` instead of deriving it from the thread id." (https://developers.openai.com/codex/app-server, §Start or resume a thread; also §thread/fork: returned `forkedFromId` when available.)
- **Do app-server thread ids match CLI session ids?** Both are UUIDs over the same rollout store (see archive/unarchive quotes above), and the exec JSONL `thread.started.thread_id` is a UUID that `codex exec resume` accepts as SESSION*ID. The docs never state in one sentence "app-server threadId == CLI session uuid", so treat it as \_same persisted id space, empirically interchangeable*, but **capture and use the id each surface gives you** (don't cross-derive).

## 4. `codex app-server` — the current integration protocol

Subcommand (0.145.0 help): `codex app-server` "[experimental] Run the app server or related tooling", subcommands `daemon`, `proxy`, `generate-ts`, `generate-json-schema`; options `--listen <stdio://|unix://|unix://PATH|ws://IP:PORT|off>`, `--stdio`, ws auth flags (`--ws-auth capability-token|signed-bearer-token`, `--ws-token-file`, `--ws-token-sha256`, `--ws-shared-secret-file`, `--ws-issuer/--ws-audience/--ws-max-clock-skew-seconds`), `-c` overrides. Official doc: https://developers.openai.com/codex/app-server (md; same content committed at `codex-rs/app-server/README.md`, 200 KB, in https://github.com/openai/codex).

**Transport & framing:** JSON-RPC 2.0 with the `"jsonrpc":"2.0"` header omitted on the wire. Default **stdio = newline-delimited JSON (JSONL)**. WebSocket transport exists but is "experimental and unsupported for production". Health probes in ws mode: `GET /readyz`, `GET /healthz` (403 on `Origin` header). Backpressure: JSON-RPC error **code `-32001`**, message `"Server overloaded; retry later."` → retry with exponential backoff + jitter. Tracing: `RUST_LOG`, `LOG_FORMAT=json` (stderr).

**Schema generation (pin your bindings to a version):**

```
codex app-server generate-ts --out ./schemas
codex app-server generate-json-schema --out ./schemas   # add --experimental for gated fields
```

The official Claude Code plugin does exactly this in `package.json` (`prebuild`: `codex app-server generate-ts --out plugins/codex/.generated/app-server-types`).

**Handshake (once per connection; server rejects anything before it):**

```json
{"method":"initialize","id":0,"params":{"clientInfo":{"name":"my_product","title":"My Product","version":"0.1.0"}}}
{"method":"initialized","params":{}}
```

- `clientInfo` fields: **`name`, `title`, `version`** (example from the VS Code extension: `"name":"codex_vscode"`). `clientInfo.name` is used for OpenAI Compliance Logs; enterprise integrations should contact OpenAI to be added to the known-clients list.
- Response returns the upstream user-agent string + `platformFamily`, `platformOs`.
- `params.capabilities`: `experimentalApi` (bool — gates experimental methods/fields, error text: "`<descriptor> requires experimentalApi capability`"), `optOutNotificationMethods` (exact notification names; unknown ignored), `requestAttestation`, `mcpServerOpenaiFormElicitation`. Second `initialize` → `Already initialized` error.

**Threads (v2 method names — replaces old newThread/v1):**

```json
{"method":"thread/start","id":10,"params":{"model":"gpt-5.6-terra","cwd":"/Users/me/project","approvalPolicy":"never","sandbox":"workspaceWrite","personality":"friendly","serviceName":"my_app_server_client"}}
{"id":10,"result":{"thread":{"id":"thr_123","sessionId":"thr_123","preview":"","ephemeral":false,"modelProvider":"openai","createdAt":1730910000}}}
{"method":"thread/started","params":{"thread":{"id":"thr_123"}}}
```

- **Thread id field name: `thread.id`** (with `thread.sessionId` alongside). There is **no `conversationId`** anywhere in the current protocol (grep of `codex-rs/app-server/README.md`: 0 hits).
- `thread/start` auto-subscribes the connection to that thread's turn/item events (there is **no `addThreadListener`** method in the current protocol; unsubscribe is `thread/unsubscribe`).
- `thread/resume`: `{"method":"thread/resume","id":11,"params":{"threadId":"thr_123","personality":"friendly"}}` → same result shape as `thread/start`. Also accepts the `thread/start` overrides (cwd/model/approvalPolicy/sandbox). Resuming with a different model than the rollout emits a warning + one-time model-switch instruction next turn.
- `thread/fork` (params `threadId`, optional `lastTurnId`, `ephemeral`) → new thread id; emits `thread/started`; result includes `forkedFromId`.
- Other thread methods (doc §API overview): `thread/read` (`includeTurns`), `thread/list` (cursor pagination; filters `modelProviders`,`sourceKinds`,`archived`,`isPinned`,`cwd`,`useStateDbOnly`,`searchTerm`, experimental `parentThreadId`/`ancestorThreadId`), `thread/turns/list` + `thread/items/list` (experimental pagination), `thread/loaded/list`, `thread/name/set`, `thread/goal/set|get|clear`, `thread/metadata/update`, `thread/archive|unarchive|delete`, `thread/unsubscribe`, `thread/compact/start`, `thread/inject_items`, `thread/rollback` (deprecated), `thread/shellCommand`, background-terminal methods (experimental).

**Turns:**

- `turn/start` is the v2 of the old `sendUserTurn` (0 hits for `sendUserTurn` in current README):

```json
{"method":"turn/start","id":30,"params":{
  "threadId":"thr_123",
  "input":[{"type":"text","text":"Run tests"}],
  "cwd":"/Users/me/project",
  "approvalPolicy":"unlessTrusted",
  "sandboxPolicy":{"type":"workspaceWrite","writableRoots":["/Users/me/project"],"networkAccess":true},
  "model":"gpt-5.6-terra","effort":"medium","summary":"concise","personality":"friendly",
  "outputSchema":{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false}}}
{"id":30,"result":{"turn":{"id":"turn_456","status":"inProgress","items":[],"error":null}}}
```

- Input item shapes: `{"type":"text","text":…}`, `{"type":"image","url":…}`, `{"type":"localImage","path":…}`; explicit skill invocation: text containing `$<skill-name>` plus `{"type":"skill","name":"skill-creator","path":"/Users/me/.codex/skills/skill-creator/SKILL.md"}`.
- `turn/start` overrides (model/effort/personality/cwd/sandbox/summary) become defaults for later turns on the thread; `outputSchema` applies only to the current turn. `sandboxPolicy` shapes: `{"type":"readOnly","access":{"type":"fullAccess"}}`; `{"type":"workspaceWrite","writableRoots":[…],"readOnlyAccess":{"type":"restricted","includePlatformDefaults":true,"readableRoots":[…]},"networkAccess":false}`; `externalSandbox` takes `networkAccess: "restricted"|"enabled"` while `workspaceWrite` keeps boolean `networkAccess`. Beta clients can pass `permissions` (permission-profile id) instead of `sandbox` (never both).
- `turn/steer` (append input to in-flight turn; requires `expectedTurnId`; no new `turn/started`; no turn-level overrides) → `{turnId}`. `turn/interrupt` `{"threadId","turnId"}` → `{}` and the turn ends `status:"interrupted"`. `review/start` (`delivery: "inline"|"detached"`, `target: uncommittedChanges|baseBranch|commit|custom`) → `{turn, reviewThreadId}`; streams `enteredReviewMode`/`exitedReviewMode` items. `command/exec` family runs one command under the server sandbox outside a thread/turn.

**Streamed notifications (v2 names — the old `codex/event/*` family is gone; 0 hits in current README):**

- Thread: `thread/started`, `thread/archived`, `thread/unarchived`, `thread/closed`, `thread/status/changed`, `thread/name/updated`, `thread/goal/*`, `thread/tokenUsage/updated`.
- Turn: `turn/started` `{turn:{id,items:[],status:"inProgress"}}`, `turn/completed` `{turn:{…,status:"completed"|"interrupted"|"failed", error}}`, `turn/diff/updated` `{threadId,turnId,diff}`, `turn/plan/updated` `{turnId,explanation?,plan:[{step,status}]}`, plus `hook/started|completed`, `model/safetyBuffering/updated`, `model/rerouted`, `model/verification`.
- Items: `item/started` and `item/completed` each carry the full `item`; deltas: `item/agentMessage/delta`, `item/plan/delta`, `item/reasoning/summaryTextDelta` (+`summaryPartAdded`, `textDelta`), `item/commandExecution/outputDelta`. (`item/fileChange/outputDelta` deprecated/never emitted by current versions — use `fileChange` items + `turn/diff/updated`.)
- **`ThreadItem` tagged-union types** (doc §Items): `userMessage {id, content}`, `agentMessage {id, text, phase?}` (`phase`: `commentary`|`final_answer`), `plan {id, text}`, `reasoning {id, summary, content}`, `commandExecution {id, command, cwd, status, commandActions, aggregatedOutput?, exitCode?, durationMs?}`, `fileChange {id, changes:[{path,kind,diff}], status}`, `mcpToolCall {id, server, tool, status, arguments, appContext?, pluginId?, result?, error?}`, `dynamicToolCall`, `collabToolCall {id, tool, status, senderThreadId, receiverThreadId?, newThreadId?, …}`, `webSearch {id, query, action?}` (`action.type`: `search{query?|queries?}`|`openPage{url?}`|`findInPage{url?,pattern?}`), `imageView`, `enteredReviewMode`/`exitedReviewMode {id, review}`, `contextCompaction {id}`, `subAgentActivity {id, kind, agentThreadId, agentPath}`.
- Errors: on failure an `error` event `{error:{message, codexErrorInfo?, additionalDetails?}}` then `turn/completed` with `status:"failed"`. `codexErrorInfo` values: `ContextWindowExceeded`, `UsageLimitExceeded`, `HttpConnectionFailed`, `ResponseStreamConnectionFailed`, `ResponseStreamDisconnected`, `ResponseTooManyFailedAttempts`, `BadRequest`, `Unauthorized`, `SandboxError`, `InternalServerError`, `Other`; upstream HTTP status in `codexErrorInfo.httpStatusCode`.

**Approvals (server→client JSON-RPC requests; client responds with the decision as the result):**

- Command execution: after `item/started` (pending `commandExecution`), server sends **`item/commandExecution/requestApproval`** with `{itemId, threadId, turnId, reason?, command?, cwd?, commandActions?, proposedExecpolicyAmendment?, networkApprovalContext?, availableDecisions?}` (+experimental `additionalPermissions` under `experimentalApi`). Client replies one of: `accept`, `acceptForSession`, `decline`, `cancel`, or `{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["cmd","…"]}}`. Then `serverRequest/resolved` and final `item/completed` (`status: completed|failed|declined`). `networkApprovalContext` present ⇒ managed **network** approval (render host/protocol prompt; grouped by host+protocol+port).
- File change: **`item/fileChange/requestApproval`** with `{itemId, threadId, turnId, reason?, grantRoot?}`; decisions `accept`, `acceptForSession`, `decline`, `cancel`.
- Also: `tool/requestUserInput` (1–3 questions, `autoResolutionMs`), `item/permissions/requestApproval` (respond `{permissions, scope:"session"|"turn"}`), `mcpServer/elicitation/request` (form/url modes), dynamic tool calls `item/tool/call` (experimental), MCP app tool-call approvals.
- Legacy method names `execCommandApproval` / `applyPatchApproval` do **not** exist in the current protocol (0 hits in `codex-rs/app-server/README.md`) — they belong to the retired v1 surface.

**Auth over app-server** (doc §Auth endpoints): `account/read {refreshToken:false}` → `{account:{type:"apiKey"|"chatgpt"{email,planType}|"amazonBedrock"{credentialSource}|"chatgptAuthTokens", requiresOpenaiAuth}}`; `account/login/start` `{type:"apiKey",apiKey}|{type:"chatgpt",useHostedLoginSuccessPage?,appBrand?}|{type:"chatgptDeviceCode"}|{type:"chatgptAuthTokens",accessToken,chatgptAccountId,chatgptPlanType}` → browser flow returns `{loginId, authUrl}`, device flow returns `{loginId, verificationUrl:"https://auth.openai.com/codex/device", userCode}`; notifications `account/login/completed {loginId,success,error}` and `account/updated {authMode, planType}`; `account/login/cancel {loginId}`, `account/logout`, `account/rateLimits/read`, `account/usage/read`, `account/chatgptAuthTokens/refresh` (server request, ~10 s timeout).

**Skills over app-server:** `skills/list {cwds:[…], forceReload?, perCwdExtraUserRoots?}` → `{data:[{cwd, skills:[{name, description, enabled, interface?, dependencies?}], errors}]}` (server reads `interface`/`dependencies` from `SKILL.json` when present); `skills/config/write {path, enabled}`; `skills/changed` notification.

**Shutdown:** no shutdown method is documented. The official plugin client closes by ending the child's stdin and SIGTERM after a grace timer (`plugins/codex/scripts/lib/app-server.mjs`). Treat clean shutdown as "close the transport".

**Where the protocol source lives (openai/codex):**

- `codex-rs/app-server/` — server crate; its `README.md` is the full protocol reference (200 KB).
- `codex-rs/app-server-protocol/` — protocol definitions (`src/export.rs` ~109 KB of typed schemas, `src/protocol/`, `src/rpc.rs`, schema fixtures).
- Satellite crates: `app-server-client`, `app-server-daemon`, `app-server-transport`, `app-server-protocol-noop-macros`, `app-server-test-client` (used by `codex debug app-server send-message-v2`).
- Note: TypeScript types are **not** committed; you generate them per-version with `codex app-server generate-ts`.

## 5. Auth (CLI)

- **Sign in with ChatGPT (default):** `codex login` opens a browser OAuth flow (https://developers.openai.com/codex/auth). Subscription-based usage.
- **API key:** `printenv OPENAI_API_KEY | codex login --with-api-key` (CLI auth page). For per-invocation key without stored login: `CODEX_API_KEY=… codex exec …` (https://developers.openai.com/codex/noninteractive; applies to `codex exec`, `codex review`, TS SDK, `codex exec-server --remote`). Docs explicitly warn **not** to export `OPENAI_API_KEY`/`CODEX_API_KEY` at job level in workflows that run repo-controlled code.
- **Enterprise access tokens:** `printenv CODEX_ACCESS_TOKEN | codex login --with-access-token` (ChatGPT Enterprise "Codex access tokens"; https://learn.chatgpt.com/docs/enterprise/access-tokens). With workload identity federation, Codex rejects `codex login`/`codex logout` (env-controlled auth).
- **Status check (non-interactive):** `codex login status` — "exits with `0` when credentials are present, which is helpful in automation scripts" (https://developers.openai.com/codex/cli/reference). Local 0.145.0 output: `Logged in using ChatGPT`.
- **Credential store:** `~/.codex/auth.json` — docs: "Treat `~/.codex/auth.json` like a password: it contains access tokens" (https://developers.openai.com/codex/noninteractive, CI/CD section). `codex logout` clears both API-key and ChatGPT credentials.
- CI/CD with ChatGPT-managed auth (seeding/refreshing `auth.json` on runners): https://learn.chatgpt.com/docs/auth/ci-cd-auth; API-key path in CI should use `openai/codex-action`.

## 6. Config (`~/.codex/config.toml`)

Reference: https://developers.openai.com/codex/config-reference (md); advanced: …/config-advanced. Keys relevant to integration (exact names from the reference):

- `model` (string), `model_reasoning_effort` = `minimal|low|medium|high|xhigh` ("xhigh is model-dependent"), `model_reasoning_summary`, `service_tier`, `plan_mode_reasoning_effort`; managed defaults via `models.new_thread.model` / `models.new_thread.model_reasoning_effort` / `models.new_thread.service_tier`.
- `approval_policy` = `untrusted | on-request | never | { granular = { sandbox_approval, rules, mcp_elicitations, request_permissions, skill_approval } }`; "`on-failure` is deprecated; use `on-request`". (App-server approvalPolicy string equivalents appear as `untrusted`/`on-request`/`never`/`unlessTrusted` in doc examples — e.g. `turn/start` example uses `"unlessTrusted"`; prefer `never` for unattended clients.)
- `sandbox_mode` = `read-only | workspace-write | danger-full-access`.
- `sandbox_workspace_write.writable_roots` (array<string>), **`sandbox_workspace_write.network_access` (boolean, outbound network inside workspace-write sandbox)**, `sandbox_workspace_write.exclude_tmpdir_env_var`, `sandbox_workspace_write.exclude_slash_tmp`.
- `notify` (array<string>): "Command invoked for notifications; receives a JSON payload from Codex." (User-level only — not allowed in project-local `.codex/config.toml`, along with provider/telemetry keys.)
- `[[skills.config]]` entries: `path` (skill folder / SKILL.md path) + `enabled` (bool).
- `tui.resume_cwd` = `"current"|"session"` (resume cwd-mismatch prompt).
- Profiles: `-p/--profile <name>` layers `$CODEX_HOME/<name>.config.toml`; project overrides in `.codex/config.toml` load only for trusted projects. Per-project trust stored as `[projects."<path>"] trust_level = "trusted"` (verified in local config).
- Local 0.145.0 config observed using `model = "gpt-5.6-sol"`, `model_reasoning_effort = "low"` — model names move fast; never hardcode, read from `model/list`/config.

## 7. Codex Agent Skills (SKILL.md)

Official doc: https://developers.openai.com/codex/skills (md: "Build skills"). Codex **supports SKILL.md skills**, built on the open agent-skills standard (https://agentskills.io).

- **Format:** a directory with **`SKILL.md`** (required) + optional `scripts/`, `references/`, `assets/`, and `agents/openai.yaml` (optional UI metadata / invocation policy / tool dependencies). **Frontmatter must include `name` and `description`**; description drives implicit invocation, so write clear scope/trigger text.
- **Frontmatter example (docs):**
  ```md
  ---
  name: skill-name
  description: Explain exactly when this skill should and should not trigger.
  ---
  ```
- **Discovery locations (docs table):** REPO: `$CWD/.agents/skills` (+ every dir from CWD up to repo root, i.e. `$REPO_ROOT/.agents/skills`); **USER: `$HOME/.agents/skills`**; ADMIN: `/etc/codex/skills`; SYSTEM: bundled by OpenAI (e.g. `skill-creator`, `plan`). Symlinked skill folders are followed. Duplicate `name`s are not merged — both appear.
  - Caveat: the app-server doc's skill example uses the path `/Users/me/.codex/skills/skill-creator/SKILL.md`, so `~/.codex/skills` paths appear in protocol examples, but the current skills doc's documented user scope is `$HOME/.agents/skills`. For new integrations follow the doc table; accept `~/.codex/skills` paths when handed one.
- **Invocation:** explicit via `$skill-name` in Codex CLI/IDE (`/skills` picker; `@` in ChatGPT), implicit by `description` match. Initial skills list is capped at **2% of the context window (8,000 chars fallback)**; Codex shortens descriptions first and may omit skills with a warning. Progressive disclosure: full SKILL.md loads only on use.
- **Management:** `[[skills.config]]` in config.toml or app-server `skills/config/write`; `$skill-installer <name>` installs curated skills; skills auto-detected on change (restart Codex if stale). App-server extras: `skills/list`, `skills/changed` notification, `SKILL.json` `interface`/`dependencies` metadata.

## 8. openai/codex-plugin-cc (official Codex plugin for Claude Code)

Repo: https://github.com/openai/codex-plugin-cc — "Use Codex from Claude Code to review code or delegate tasks." **License: Apache-2.0** (LICENSE 10,944 B + NOTICE; `package.json` `"license":"Apache-2.0"`). Current version **1.0.6**; default branch `main`; requires Node ≥18.18; uses your local `codex` binary + local auth + your existing Codex config (README: "The Codex plugin wraps the Codex app server").

**Structure (verified tree):**

```
.claude-plugin/marketplace.json      # Claude Code marketplace manifest
plugins/codex/.claude-plugin/plugin.json
plugins/codex/commands/{review,adversarial-review,rescue,transfer,status,result,cancel,setup}.md
plugins/codex/agents/codex-rescue.md
plugins/codex/skills/{codex-cli-runtime,codex-result-handling,gpt-5-4-prompting}/SKILL.md
plugins/codex/hooks/hooks.json       # SessionStart/SessionEnd/Stop hooks
plugins/codex/prompts/{adversarial-review,stop-review-gate}.md
plugins/codex/schemas/review-output.schema.json
plugins/codex/scripts/{codex-companion.mjs,app-server-broker.mjs,session-lifecycle-hook.mjs,stop-review-gate-hook.mjs,lib/*}
scripts/, tests/, package.json, tsconfig.app-server.json
```

- **Manifest format:** `.claude-plugin/marketplace.json` = `{name:"openai-codex", owner:{name:"OpenAI"}, metadata:{description, version}, plugins:[{name:"codex", description, version, author, source:"./plugins/codex"}]}`; plugin manifest `plugins/codex/.claude-plugin/plugin.json` = `{name, version, description, author}`. Install: `/plugin marketplace add openai/codex-plugin-cc` then `/plugin install codex@openai-codex`, `/reload-plugins`, `/codex:setup`.
- **Slash commands** are markdown with frontmatter, e.g. `review.md`: `description`, `argument-hint: '[--wait|--background] [--base <ref>] [--scope …]'`, `disable-model-invocation: true`, `allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion`; body instructs Claude to run `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review "$ARGUMENTS"` and return stdout verbatim.
- **Subagent** `agents/codex-rescue.md`: frontmatter `name: codex-rescue`, `model: sonnet`, `tools: Bash`, `skills: [codex-cli-runtime, gpt-5-4-prompting]`; a thin forwarder that makes exactly one Bash call to `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task …` (adds `--write` by default; `--resume` → `task --resume-last`; maps `spark` → `--model gpt-5.3-codex-spark`).
- **How it invokes Codex: exclusively through `codex app-server`** (spawn `codex app-server` on stdio; no `codex exec` in the runtime path). `scripts/lib/app-server.mjs`:
  - `initialize` with `clientInfo: {title:"Codex Plugin", name:"Claude Code", version:<plugin version>}` and `capabilities: {experimentalApi:false, requestAttestation:false, optOutNotificationMethods:["item/agentMessage/delta","item/reasoning/summaryTextDelta","item/reasoning/summaryPartAdded","item/reasoning/textDelta"]}`, then `initialized` notification.
  - Thread params: `{cwd, model: options.model ?? null, approvalPolicy:"never", sandbox:"read-only", serviceName:<const>, ephemeral: options.ephemeral ?? true}`; resume: `{threadId, cwd, model, approvalPolicy:"never", sandbox}`; turn input: `[{type:"text", text, text_elements:[]}]`.
  - Methods used (from `lib/app-server-protocol.d.ts` + `codex.mjs`): `initialize`, `thread/start`, `thread/resume`, `thread/name/set`, `thread/list`, `review/start`, `turn/start`, `turn/interrupt`, `account/read` (`{refreshToken:false}` for `/codex:setup`), `externalAgentConfig/import`, plus notification handling of `thread/started`, `turn/started` (captures `params.turn.id`), `item/completed`, `turn/completed`, `thread/name/updated`.
  - A broker (`app-server-broker.mjs`, unix socket) serializes one app-server across concurrent Claude jobs; busy clients get JSON-RPC error code **-32001** ("Shared Codex broker is busy") and the client falls back to spawning a direct app-server.
  - TS types are generated per installed CLI version: `prebuild` runs `codex app-server generate-ts --out plugins/codex/.generated/app-server-types` then `tsc -p tsconfig.app-server.json`.
- **Session id tracking:** `/codex:result` and `/codex:status` surface the Codex session ID from the finished job so the user can run `codex resume <session-id>`; `/codex:transfer` converts the Claude Code transcript (source must be under `~/.claude/projects`) via app-server `externalAgentConfig/import` with `migrationItems:[{itemType:"SESSIONS", details:{sessions:[{path, cwd, title}]}}]` and waits for `externalAgentConfig/import/completed`; the imported thread id is recorded in `~/.codex/external_agent_session_imports.json` (records: `source_path`, `content_sha256`, `imported_thread_id`), and the plugin prints `codex resume <session-id>`.
- **Review gate (optional):** `hooks.json` `Stop` hook runs `stop-review-gate-hook.mjs` (timeout 900) which triggers a targeted Codex review and blocks Claude's stop on findings; enabled via `/codex:setup --enable-review-gate`.

## 9. Codex MCP server status

- **`codex mcp-server` is deprecated.** Official wording (https://developers.openai.com/codex/cli/reference, §`codex mcp-server`): "`codex mcp-server` is deprecated. Use the Codex app server instead. To call Codex from Claude Code, use the Codex plugin for Claude Code (https://github.com/openai/codex-plugin-cc), which uses the app server. For existing integrations, the command runs Codex as an MCP server over stdio…"
- **What replaced it:** `codex app-server` (JSON-RPC v2 protocol above) for rich clients/automation; the TypeScript **Codex SDK** for job automation/CI (docs point automators to it: https://learn.chatgpt.com/docs/codex-sdk, linked from the app-server page); `openai/codex-action` for GitHub Actions.
- **Unrelated and not deprecated:** `codex mcp` (`list|get|add|remove|login|logout`) manages _external_ MCP servers Codex connects to (stored in `~/.codex/config.toml`; stdio + streamable HTTP; OAuth for streamable HTTP) — this is config management, not "Codex as an MCP server".
- I did not find the deprecation on a public changelog page I could fetch (`developers.openai.com/codex/changelog.md` → 404); the authoritative confirmation is the CLI reference quote above (plus the app-server doc's role statement: "app-server is the interface Codex uses to power rich clients (for example, the Codex VS Code extension)").

---

## MINIMUM VERSIONS & GAPS

**Minimum versions**

- **Build app-server integrations against ≥ 0.145.0** (installed baseline): current v2 JSON-RPC surface (`thread/start`, `thread/resume`, `turn/start|steer|interrupt`, v2 approvals, `account/*`, `skills/*`) is fully present; `generate-ts`/`generate-json-schema` available for pinned bindings. All app-server method names verified in this report were checked against repo `main` (post-0.151) — 0.145.0's `app-server --help` and plugin code (which supports 0.145-era CLIs) confirm the same v2 names; guard for "unknown method" errors on older binaries exactly as the official plugin does.
- `--json` JSONL event stream: stable in 0.145.0 (verified live). `--experimental-json` accepted but legacy.
- `codex exec resume --last`, `--all`, UUID-or-name SESSION_ID: present in 0.145.0.
- Skills: `$skill` invocation + `/skills` + `.agents/skills` scopes documented for current CLI; 0.145.0 shipped concurrent skill/plugin discovery.
- Plugin `codex-plugin-cc` 1.0.6 requires Node ≥18.18 and pairs with a local `codex` binary; older Codex versions "that do not expose session import must be upgraded" for `/codex:transfer` (README).

**Gaps / not officially documented (do not invent)**

1. **`codex exec` exit codes** — no official table (only: 0 on success observed; required-MCP failure → error exit; `codex login status` → 0 when credentials present). Use `turn.failed`/`error` events + process exit status.
2. **`--full-auto`** — documented as a deprecated compatibility flag that warns; absent from 0.145.0 `exec --help`. Don't build on it.
3. **App-server shutdown RPC** — none documented; official client just closes stdin/SIGTERM.
4. **threadId == CLI session uuid equivalence** — strongly implied by the shared rollout store (`thread/archive`/`unarchive` wording) and matching UUID formats, but never stated as one sentence in docs. Capture ids per surface.
5. **`~/.codex/skills` as a skills root** — appears in app-server doc examples, but the skills doc's USER scope is `$HOME/.agents/skills`. Prefer the documented table.
6. **Stable TS types** — not published as a package; must be generated per CLI version (`codex app-server generate-ts`).
7. **Deprecated-method archaeology** (`newThread`, `sendUserTurn`, `addThreadListener`, `codex/event/*`, `execCommandApproval`, `applyPatchApproval`, `conversationId`) — zero occurrences in the current `codex-rs/app-server/README.md`; they exist only in older third-party writeups. The v1→v2 rename is not documented as a migration table anywhere official.
8. **WebSocket transport & paginated history** — explicitly experimental/unsupported (`-32601` for paginated thread creation); stdio is the supported transport.
9. Docs hosts are in flux: developers.openai.com/codex/_ redirects to learn.chatgpt.com/docs/_; `codex/changelog.md` is not a valid page (changelog lives at learn.chatgpt.com/docs/changelog for ChatGPT/Codex product changes; CLI release notes live in GitHub Releases).

---

## RECOMMENDED INTEGRATION DEFAULTS

### A) Primary path: `codex app-server` over stdio (JSONL)

Method sequence with exact shapes (all fields from https://developers.openai.com/codex/app-server):

```
1) initialize
   → {"method":"initialize","id":0,"params":{"clientInfo":{"name":"<your-client>","title":"<Human Title>","version":"1.0.0"}}}
     optional params.capabilities:
       {"experimentalApi":false,
        "optOutNotificationMethods":["item/agentMessage/delta",
          "item/reasoning/summaryTextDelta","item/reasoning/summaryPartAdded",
          "item/reasoning/textDelta"]}            // deltas off → act on item/completed only
   ← {"id":0,"result":{...userAgent, platformFamily, platformOs}}
2) initialized (notification, no id)
   → {"method":"initialized","params":{}}
3) new thread  (NOT "newThread"; auto-subscribes — no addThreadListener)
   → {"method":"thread/start","id":1,"params":{
        "cwd":"/abs/workspace","model":null,"approvalPolicy":"never",
        "sandbox":"read-only","serviceName":"<your-service>","ephemeral":false}}
   ← {"id":1,"result":{"thread":{"id":"thr_…","sessionId":"thr_…","preview":"",
        "ephemeral":false,"modelProvider":"openai","createdAt":1730910000,…}}}
   ⇐ notification {"method":"thread/started","params":{"thread":{"id":"thr_…"}}}
   // CAPTURE: threadId = result.thread.id; sessionId = result.thread.sessionId
   // (resume later with thread/resume {threadId}; forks keep root sessionId)
4) start turn  (NOT "sendUserTurn")
   → {"method":"turn/start","id":2,"params":{
        "threadId":"thr_…",
        "input":[{"type":"text","text":"<prompt>"}]}}
   ← {"id":2,"result":{"turn":{"id":"turn_…","status":"inProgress","items":[],"error":null}}}
   ⇐ stream (no id):
      {"method":"turn/started","params":{"turn":{"id":"turn_…","status":"inProgress","items":[]}}}
      {"method":"item/started","params":{"item":{…}}}          // per item
      {"method":"item/completed","params":{"item":{…}}}        // authoritative final state
      {"method":"turn/completed","params":{"turn":{"id":"turn_…","status":"completed",…}}}
5) resume
   → {"method":"thread/resume","id":3,"params":{"threadId":"thr_…","cwd":…,"model":…,
        "approvalPolicy":"never","sandbox":"read-only"}}   // result shape = thread/start
6) interrupt an in-flight turn
   → {"method":"turn/interrupt","id":4,"params":{"threadId":"thr_…","turnId":"turn_…"}}
   ← {"id":4,"result":{}}   // turn/completed arrives with status:"interrupted"
```

Item types to render (from `item/*` params): `agentMessage {id,text}`, `reasoning {id,summary,content}`, `commandExecution {id,command,cwd,status,aggregatedOutput?,exitCode?,durationMs?}`, `fileChange {id,changes:[{path,kind,diff}],status}`, `mcpToolCall {id,server,tool,status,arguments,result?,error?}`, `webSearch {id,query,action?}`, `error`. Failure: `error` event `{error:{message,codexErrorInfo?,…}}` then `turn/completed` with `status:"failed"`.

**Approval handling** (server→client requests — answer with the decision as the JSON-RPC result, using the same `id`):

```
⇐ {"method":"item/commandExecution/requestApproval","params":{"itemId","threadId","turnId",
      "reason"?,"command"?,"cwd"?,"commandActions"?,"proposedExecpolicyAmendment"?,
      "networkApprovalContext"?,"availableDecisions"?}, "id":99}
→ {"id":99,"result":"accept"}            // "accept" | "acceptForSession" | "decline" | "cancel"
                                         // | {"acceptWithExecpolicyAmendment":{"execpolicy_amendment":[…]}}
⇐ {"method":"serverRequest/resolved", …} then final item/completed (status completed|failed|declined)

⇐ {"method":"item/fileChange/requestApproval","params":{"itemId","threadId","turnId","reason"?,"grantRoot"?}, "id":100}
→ {"id":100,"result":"accept"}           // same decision set minus execpolicy amendment
```

Unattended default: `approvalPolicy:"never"` + `sandbox:"read-only"` (or `"workspaceWrite"` with explicit `sandboxPolicy.writableRoots`, `networkAccess:false`) so approvals never fire; still implement the two handlers above for managed-network prompts and defense-in-depth. Retry on error code `-32001` ("Server overloaded; retry later") with exp backoff + jitter. ClientInfo: use a unique, honest `name` (it feeds OpenAI compliance logs; enterprise integrations should register with OpenAI). Auth check before first thread: `account/read {refreshToken:false}` → `requiresOpenaiAuth`. Shutdown: end stdin / SIGTERM (no RPC).

### B) Batch/CI path: `codex exec`

```
codex exec --json --skip-git-repo-check \
  -C <workdir> -s workspace-write -o <last-message-file> \
  [-m <model>] [-c key=value …] [--output-schema schema.json] "<prompt>"
# stdin prompt:   generate_prompt.sh | codex exec - --json
# resume:         codex exec resume --last "<follow-up>" ; codex exec resume <SESSION_ID> "…"
```

Parse JSONL on stdout: capture `thread.started.thread_id` (session id for `exec resume`), accumulate `item.completed` where `item.type=="agent_message"` (last one = final message), read `turn.completed.usage` for token accounting, treat `turn.failed` + `error` events as failure. Keep stderr for logs. Never use `--full-auto`; never pass `OPENAI_API_KEY` through environments running untrusted repo code (use `CODEX_API_KEY` scoped to the invocation or `openai/codex-action`).

### C) Choose per use-case

- Rich client / approvals / history / auth UX / session continuity → **app-server** (this is what the VS Code extension and the official Claude Code plugin use).
- One-shot or CI → **`codex exec --json`**.
- "Codex inside Claude Code" → install **`openai/codex-plugin-cc`** rather than reimplementing.
- Anything new built on `codex mcp-server` → migrate now (deprecated; replacement = app-server / TS SDK).
