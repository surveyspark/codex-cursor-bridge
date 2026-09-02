# Cursor integration guide

Working knowledge for maintaining `packages/cursor-adapter`. This is the _applied_
layer: [`research-cursor-2026-08-30.md`](research-cursor-2026-08-30.md) is the
verified reference (official `cursor.com/docs`, the npm registry, the `cursor/*`
GitHub org, and `agentclientprotocol.com`); this file turns it into decisions,
contracts, and a conformance checklist for our fakes.

Important caveat for everything below: **no Cursor transport has been exercised
end-to-end against a real CLI in this repository.**
[`compatibility.md:49-50`](compatibility.md) says so explicitly, and that honesty
must be preserved. Every ACP and SDK behaviour we rely on is inferred from
documentation and from fakes we wrote ourselves — which is exactly the situation
where a shared misunderstanding survives a green test suite.

## The install trap

The official CLI binary is **`agent`**, distributed by installer script only:

```bash
curl https://cursor.com/install -fsS | bash            # macOS, Linux, WSL
irm 'https://cursor.com/install?win32=true' | iex      # Windows PowerShell
```

**There is no official npm package.** The npm package `cursor-agent` (v1.0.3,
`zalab-inc`, last published 2025-01-10) is unrelated third-party software. Commit
`2224e9c` fixed this in our resolution logic; `cursor-agent` is accepted only as a
legacy alias. Do not reintroduce it as a primary name, and never add it to
`package.json`.

Verify with `agent --version`; update with `agent update` (auto-updates by
default, so pin nothing and detect capabilities instead).

## Three transports, one interface

Selection order, implemented at `cursor-adapter/src/index.ts:92-97`:

| Order | Transport       | Requires                       | Write authority                                                         |
| ----- | --------------- | ------------------------------ | ----------------------------------------------------------------------- |
| 1     | `@cursor/sdk`   | `CURSOR_API_KEY`, Node ≥ 22.13 | Bounded by `local.sandboxOptions.enabled`; cloud runs in an isolated VM |
| 2     | `agent acp`     | local `agent login`            | Governed by `session/request_permission` relay only                     |
| 3     | `agent --print` | explicit opt-in                | **Full write and shell access**                                         |

Our gating of transport 3 behind `allowNonInteractiveCliFallback` is correct and
verified unreachable without opt-in. The reason it must stay gated is in the
official docs verbatim: `-p/--print` "has access to all tools, including write and
shell." Without `--force` changes are only _proposed_, but that is a behaviour of
the tool, not a guarantee we control.

## ACP wire contract

`agent acp` is a hidden subcommand. Transport is stdio; envelope is JSON-RPC 2.0;
framing is newline-delimited JSON, one message per line. Client writes to stdin,
Cursor writes responses and notifications to stdout, logs go to stderr.

ACP is **not** our protocol — it is a third-party spec (Zed Industries et al.) at
`agentclientprotocol.com`, which Cursor implements plus extensions. Current is
**v1**, with `protocolVersion` as a bare **integer**. A v2 is in draft; do not
build on it.

```jsonc
// 1. initialize
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
  "protocolVersion":1,
  "clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false},
  "clientInfo":{"name":"codex-cursor-bridge","version":"<BRIDGE_VERSION>"}}}
// ← result: {protocolVersion, agentCapabilities:{loadSession, promptCapabilities, mcpCapabilities}, agentInfo, authMethods}

// 2. authenticate — Cursor advertises methodId "cursor_login"
{"jsonrpc":"2.0","id":2,"method":"authenticate","params":{"methodId":"cursor_login"}}

// 3. session/new  (or session/load to continue)
{"jsonrpc":"2.0","id":3,"method":"session/new","params":{"cwd":"/abs/path","mcpServers":[]}}
// ← {sessionId}

// 4. session/prompt
{"jsonrpc":"2.0","id":4,"method":"session/prompt","params":{
  "sessionId":"…","prompt":[{"type":"text","text":"<prompt>"}]}}
// ← {stopReason:"end_turn"}   // or "cancelled" after a cancel

// 5. cancellation — a notification, no id
{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"…"}}
```

Three things our adapter should change:

- **We never call `authenticate`.** We rely on ambient `agent login`, which works
  when the user is pre-authenticated and produces a confusing failure otherwise.
  Send it, and read `authMethods` from the `initialize` result rather than assuming
  `cursor_login` exists.
- **We send `rpc.notify("initialized")`** after initialize (`acp.ts:233`). ACP has
  no `initialized` notification — that is an app-server/MCP idiom that leaked
  across. Harmless today (notifications expect no reply) but it is protocol noise a
  stricter agent could reject.
- **We ignore `agentCapabilities.loadSession`** and simply attempt `session/load`
  inside a `try`/`catch` (`acp.ts:248-265`). The spec gates that call on the
  capability flag. Reading it is the "capability detection rather than version
  guessing" the build spec asked for, and it turns a swallowed exception into a
  clear "continuation not supported" result.

### `session/update` notifications

`params: {sessionId, update: {sessionUpdate: "<kind>", …}}`. Kinds we handle or
should: `agent_message_chunk` (`content: {type:"text", text}`), `plan`
(`entries: [{content, priority, status}]`), `tool_call`, `tool_call_update`
(status `in_progress` / `completed`). Ignore unknown kinds.

## Permissions — read this before touching `acp.ts`

On the ACP path, `session/request_permission` is **the only write control that
exists**. There is no sandbox on this transport (see
[remediation P1-3](remediation-plan.md)), so this handler is load-bearing in a way
the Codex approval handler is not.

The agent sends the request; the client answers with an outcome:

```jsonc
// agent → client
{"jsonrpc":"2.0","id":9,"method":"session/request_permission","params":{
  "sessionId":"…","toolCall":{…},
  "options":[{"optionId":"allow-once","name":"Allow once","kind":"allow_once"},
             {"optionId":"reject-once","name":"Reject","kind":"reject_once"}]}}
// client → agent, denying
{"jsonrpc":"2.0","id":9,"result":{"outcome":{"outcome":"selected","optionId":"reject-once"}}}
// or, when no reject option is offered
{"jsonrpc":"2.0","id":9,"result":{"outcome":{"outcome":"cancelled"}}}
```

### The hyphen/underscore trap

This is the single most bug-prone detail in the whole Cursor integration:

| Field                | Convention                  | Documented values                                            |
| -------------------- | --------------------------- | ------------------------------------------------------------ |
| `options[].kind`     | **underscores** (ACP spec)  | `allow_once`, `allow_always`, `reject_once`, `reject_always` |
| `options[].optionId` | **hyphens** (Cursor's docs) | `allow-once`, `allow-always`, `reject-once`                  |
| `outcome.outcome`    | —                           | `selected`, `cancelled`                                      |

Match on `kind`, send back the `optionId` **verbatim as received**. Never construct
an `optionId` yourself and never assume the two conventions agree.

Evidence that this trap already bit us: our fake returns
`optionId: "deny-once"` (`test-support/src/index.ts:155`) — a value that appears in
neither convention. It was invented, not read from the docs.

### Our defect

`acp.ts:191-192`:

```ts
const denyOption =
  options.find((o) => o.kind === "reject_once") ?? options.at(-1);
```

The fallback selects the **last option positionally**. If an agent ever offers only
`reject_always`, or orders its options with an allow kind last, we grant the
escalation — while unconditionally recording `decision: "auto-denied"` at
`acp.ts:199`. When `options` is absent we send `optionId: null`, which is not a
valid selection and leaves the request unresolved.

This is fail-closed _by luck_: both Cursor's documented option set and the ACP v1
enum include a reject option, so today's agent probably hits the `find()`. That is
not a guarantee. The correct shape:

```ts
const deny =
  options.find((o) => o.kind === "reject_once") ??
  options.find((o) => o.kind === "reject_always") ??
  options.find(
    (o) => typeof o.kind === "string" && o.kind.startsWith("reject"),
  );
if (!deny?.optionId) return { outcome: { outcome: "cancelled" } };
return { outcome: { outcome: "selected", optionId: deny.optionId } };
```

Record the `optionId` actually chosen, not a hardcoded string. And make the default
branch for _any_ unrecognised server request deny and emit an approval event —
`acp.ts:209` currently returns `{}`, which is asymmetric with the Codex handler
that correctly denies unknown methods.

The docs warn plainly: "If your client does not answer permission requests, tool
execution can block." An unanswered request is not a safe default; it is a hang.

## Cursor's ACP extension methods

Cursor-specific, so handle them defensively — they are not in the ACP spec and may
change without a protocol version bump.

| Method                  | Type                 | Shape                                                                                                                                                                                      |
| ----------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cursor/ask_question`   | **blocking request** | `{toolCallId, title?, questions:[{id, prompt, options:[{id,label}], allowMultiple?}]}` → `{outcome:{outcome:"answered", answers:[…]}}` \| `{outcome:"skipped"}` \| `{outcome:"cancelled"}` |
| `cursor/create_plan`    | **blocking request** | `{toolCallId, name?, overview?, plan, todos:[{id,content,status}], …}` → `{outcome:"accepted"\|"rejected"\|"cancelled"}`                                                                   |
| `cursor/update_todos`   | notification         | `{toolCallId, todos[], merge}`                                                                                                                                                             |
| `cursor/task`           | notification         | `{toolCallId, description, prompt, subagentType, model?, …}`                                                                                                                               |
| `cursor/generate_image` | notification         | `{toolCallId, description, filePath?, …}`                                                                                                                                                  |

The two **blocking** ones matter: an unanswered blocking request stalls the turn.
Our catch-all `return {}` at `acp.ts:209` accidentally covers them, but `{}` is not
a valid outcome for either. Answer them explicitly:
`cursor/ask_question` → `{outcome:{outcome:"cancelled"}}` (we have no human to
ask), and `cursor/create_plan` → `{outcome:"rejected", reason:"…"}` for a read-only
job, or `"accepted"` for an implement job. `cursor/task` is a subagent spawn — worth
logging as an event, since it is the closest thing to a recursion signal on this
transport.

## Modes map onto our permission profiles

ACP sessions support the same modes as the CLI: `agent` (full tool access), `plan`
(read-only behaviour), `ask` (read-only behaviour). We currently send **no mode at
all**, which means we get the `agent` default even for read-only jobs — part of why
`permissionProfile` is unenforced on this path.

| Our profile                | Should send                   | Notes                                                                                                       |
| -------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `read-only`                | `plan` or `ask`               | Read-only _behaviour_, not a sandbox. Combine with a throwaway worktree or a before/after `git status` diff |
| `isolated-workspace-write` | `agent`, `cwd` = the worktree | The worktree is the real boundary                                                                           |
| `current-workspace-write`  | `agent`                       | Explicit user choice; warn when the tree is dirty                                                           |

## The SDK path

`@cursor/sdk` (1.0.30 as researched, Node ≥ 22.13). Auth: `CURSOR_API_KEY` or an
`apiKey` option — never log it, never pass it in argv. Billing applies per Cursor's
docs, which is why ACP is the recommended default for local use.

The one field that gives us a real boundary:

```ts
Agent.create({ local: { cwd, sandboxOptions: { enabled: true } } });
```

With it, "writes are limited to the working directory (`local.cwd`) and a small set
of allowed paths. Reads outside the workspace are blocked." Shell runs under
bubblewrap (Linux) or seatbelt (macOS), and outbound network is denied by default.
Without it, "local agents run tool calls without approval — there's no
human-in-the-loop prompt in headless mode."

We currently use `permissionProfile` only for a display flag
(`sdk.ts:119-121`). Setting `sandboxOptions.enabled` for read-only jobs is the
smallest change that makes the read-only claim true on this transport.

Stability warnings from the official docs, worth honouring literally:

- "Tool call schema is not stable … Treat `args` and `result` as unknown and parse
  defensively. The event envelope (`type`, `call_id`, `name`, `status`) is stable."
- Local agents return **no artifacts** — `listArtifacts()` is empty and
  `downloadArtifact()` throws.
- `tools`/`disallowedTools` and inline `mcpServers` do **not** persist across
  `Agent.resume()`.
- Concurrent runs on one cloud agent return `409 agent_busy`.

## Identifiers

| Id             | Shape                                       | Source                                   |
| -------------- | ------------------------------------------- | ---------------------------------------- |
| SDK agent id   | `agent-<uuid>` (local), `bc-<uuid>` (cloud) | `SDKAgent.agentId`                       |
| ACP session id | opaque string                               | `session/new` result                     |
| CLI session id | UUID                                        | `session_id` in `--output-format` events |
| our `job_…`    | `job_` + 32 hex                             | this bridge                              |

Resume paths: `Agent.resume(agentId)` for the SDK, `session/load` for ACP (gated on
`agentCapabilities.loadSession`), `agent --resume <chatId>` / `agent ls` /
`agent resume` for the CLI. Persist whichever id the transport gave us; never
translate between them.

## `--print` fallback specifics

If transport 3 is ever enabled, these two facts change the parsing contract:

- `--output-format json` emits a single JSON object **on success only**. "On
  failure, the process exits with a non-zero code and writes an error message to
  stderr. No well-formed JSON object is emitted in failure cases." So absence of
  JSON _is_ the error signal.
- `--output-format stream-json` emits NDJSON; tool-call payloads are tool-specific
  (`readToolCall`, `writeToolCall`, or a generic `function` shape) and explicitly
  not a stable contract. Ignore unknown fields.

Pass the prompt via stdin or a protected temp file, never a shell-expanded string.

## Conformance checklist for `fakeCursorAcp`

Our fake currently has a structural error that voids the entire permission test:
it handles `session/request_permission` as an **inbound** method
(`test-support/src/index.ts:154`), but in ACP the _agent_ sends that request to the
_client_. So the fake never sends it, `requestPermission: true` is a dead option,
and `tests/protocol/adapters.test.ts:189-211` asserts `approvals.length === 0` —
the opposite of its own name. `acp.ts:186-207` has **zero** execution coverage.

- [ ] **Sends** `session/request_permission` as a server→client request with a
      realistic `options` array, and asserts the `optionId` we return is a reject
      option.
- [ ] Includes a variant whose options are ordered with an allow kind **last**, and
      a variant offering only `reject_always`. These are the tests for the `at(-1)`
      defect.
- [ ] Includes a variant with **no** `options` array, asserting we answer
      `{outcome:{outcome:"cancelled"}}` rather than `optionId: null`.
- [ ] Sends a **renamed** permission method (e.g. `session/v2/request_permission`)
      and asserts we deny rather than answer `{}`.
- [ ] Sends `cursor/ask_question` and `cursor/create_plan` and asserts we return a
      _valid_ outcome for each, not `{}`.
- [ ] Advertises `agentCapabilities.loadSession: false` in one variant and asserts
      we report continuation as unsupported instead of swallowing a `session/load`
      failure.
- [ ] Rejects an `initialize` whose `protocolVersion` is not `1`, and one missing
      `clientCapabilities`.
- [ ] Asserts we sent `authenticate` before `session/new` (once P1-3 lands).
- [ ] Uses `optionId` values from the documented set (`allow-once`, `allow-always`,
      `reject-once`) — **not** the invented `deny-once`.
- [ ] Returns only documented `stopReason` values. Ours currently returns
      `"refusal"` (`test-support:151`), which appears in no official source; ACP
      documents `end_turn` and `cancelled`. Either verify `refusal` against current
      docs or model refusal a different way.
- [ ] Has a variant that **writes a file** into `cwd` during a read-only job, so the
      missing read-only enforcement (P1-3) becomes a failing test.
- [ ] Has variants for `initialize` failure, mid-turn exit, stderr noise, a message
      split across two writes, and a turn slower than the job timeout.

## Divergences: this repo vs the protocol

Current as of `cfd5556`. Remediation ids in brackets.

| #   | Our behaviour                                                                | Protocol                                    | Severity                                                   |
| --- | ---------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------- |
| 1   | `permissionProfile` ignored on both ACP and SDK (`acp.ts:151`, `sdk.ts:119`) | ACP has modes; the SDK has `sandboxOptions` | **"read-only by default" is unenforced here** [P1-3]       |
| 2   | Deny falls back to `options.at(-1)` (`acp.ts:192`)                           | select a reject `kind` or cancel            | can grant an escalation while logging "auto-denied" [P1-4] |
| 3   | Unknown server requests answered `{}` (`acp.ts:209`)                         | deny, or a valid outcome                    | fail-open; stalls blocking `cursor/*` requests [P1-4]      |
| 4   | Fake never sends the permission request (`test-support:154`)                 | agent→client direction                      | the deny path is untested [P3-3]                           |
| 5   | No `authenticate` call                                                       | `methodId: "cursor_login"`                  | confusing failure when not pre-authenticated               |
| 6   | `rpc.notify("initialized")` sent (`acp.ts:233`)                              | no such ACP notification                    | protocol noise                                             |
| 7   | `agentCapabilities.loadSession` ignored                                      | gates `session/load`                        | swallowed failure instead of an honest "no continuation"   |
| 8   | No `mode` sent on `session/new`                                              | `agent` / `plan` / `ask`                    | read-only jobs get full tool access                        |
| 9   | No `clientInfo` in `initialize`                                              | Cursor's example includes it                | cosmetic                                                   |
| 10  | `adapter.reply()` never called (`job-manager.ts:537`)                        | `session/load` exists                       | documented continuation absent [P0-5]                      |

## Do not

- Add `cursor-agent` from npm as a dependency or a primary binary name.
- Use private Cursor APIs, UI/keyboard automation, or credentials read out of
  application storage.
- Hardcode model ids. "Discover, don't hard-code" — `agent models`,
  `Cursor.models.list()`, or `GET /v1/models`.
- Parse ANSI or decorative terminal output when a structured message exists.
- Assume team-level (dashboard) MCP servers work in ACP mode — they do not. Only
  project-level and user-level `.cursor/mcp.json`.
- Assume `session/resume` or session list/delete exist in Cursor. They are ACP v1
  spec features that Cursor's own page does not mention; only `session/load` is
  documented for Cursor.
- Pass `CURSOR_API_KEY` on the command line. Use the environment, and keep it out of
  `buildChildEnv` unless the SDK transport is the one selected.

## Sources

Primary: [`research-cursor-2026-08-30.md`](research-cursor-2026-08-30.md), citing
`cursor.com/docs/*` (skills, hooks, rules, mcp, cli/_, sdk/typescript,
cloud-agent/api), `agentclientprotocol.com` (protocol v1), the npm registry, and
the `cursor/_` GitHub org listing. Re-verify before each release — the CLI
auto-updates, so our assumptions can go stale without any action on our part — and
record deviations in [`compatibility.md`](compatibility.md).
