# Codex integration guide

Working knowledge for maintaining `packages/codex-adapter`. This is the _applied_
layer: [`research-codex-2026-08-30.md`](research-codex-2026-08-30.md) is the
verified protocol reference (researched against codex-cli 0.145.0 locally, npm
`latest` 0.151.0, and repo `main`); this file turns it into decisions, contracts,
and a conformance checklist for our fakes.

When the two disagree, the research report wins on **protocol facts** and this file
wins on **what our adapter should do about them**. Both lose to the current
official docs — record any deviation in
[`compatibility.md`](compatibility.md).

## Mental model

Codex exposes two surfaces we can legitimately use, and one we must not.

| Surface             | Use                                                     | Why                                                                                                                                  |
| ------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `codex app-server`  | **Primary.** JSON-RPC 2.0 over stdio, newline-delimited | The interface the VS Code extension and OpenAI's own Claude Code plugin use. Threads, turns, streamed items, approvals, resume, auth |
| `codex exec --json` | **Fallback only.** One-shot JSONL                       | No live continuation. Our result must say so honestly rather than implying resumability                                              |
| `codex mcp-server`  | **Never**                                               | Officially deprecated in favour of app-server                                                                                        |

Note `codex mcp` (`list`/`add`/`remove`/…) is unrelated and not deprecated — it
manages _external_ MCP servers that Codex connects to. Do not confuse the two.

The framing detail that matters for us: app-server omits the `"jsonrpc":"2.0"`
header on the wire. Our `JsonRpcConnection` tolerates this, but a strict validator
would not — do not add one.

## Handshake

```jsonc
// 1. request
{"method":"initialize","id":0,"params":{
  "clientInfo":{"name":"codex-cursor-bridge","title":"codex-cursor-bridge","version":"<BRIDGE_VERSION>"},
  "capabilities":{
    "experimentalApi": false,
    "optOutNotificationMethods":[
      "item/agentMessage/delta","item/reasoning/summaryTextDelta",
      "item/reasoning/summaryPartAdded","item/reasoning/textDelta"]}}}
// 2. notification, no id
{"method":"initialized","params":{}}
```

`clientInfo.name` feeds OpenAI's compliance logs, so keep it honest and stable.
A second `initialize` on the same connection is an error.

Two improvements we should make (see remediation P5-5 and below):

- We hardcode `version: "0.1.0"` at `app-server.ts:449` while the package is
  0.1.1. Use `BRIDGE_VERSION` from `bridge-core/src/types.ts`.
- We send no `capabilities` at all, so Codex streams us four delta notification
  families we never consume. Opting out as above is what the official plugin does
  and cuts pointless traffic through the line splitter.

## Threads and turns (v2 names)

The v1 surface is gone. If you see any of these names in code, docs, or a
third-party writeup, it is stale: `newThread`, `sendUserTurn`,
`addThreadListener`, `codex/event/*`, `conversationId`, `execCommandApproval`,
`applyPatchApproval`. All have zero occurrences in the current protocol reference.

```jsonc
// thread/start — auto-subscribes this connection to the thread's events.
// There is no addThreadListener.
{"method":"thread/start","id":1,"params":{
  "cwd":"/abs/path","sandbox":"read-only","approvalPolicy":"never",
  "model":null,"serviceName":"codex-cursor-bridge","ephemeral":false}}
{"id":1,"result":{"thread":{"id":"…","sessionId":"…","modelProvider":"openai",…}}}

// turn/start — the v2 of sendUserTurn
{"method":"turn/start","id":2,"params":{
  "threadId":"…",
  "input":[{"type":"text","text":"<prompt>"}],
  "sandboxPolicy":{"type":"workspaceWrite","writableRoots":["/abs/path"],"networkAccess":false},
  "model":"…","effort":"medium"}}
{"id":2,"result":{"turn":{"id":"…","status":"inProgress","items":[],"error":null}}}

// thread/resume — same result shape as thread/start; accepts the same overrides
{"method":"thread/resume","id":3,"params":{"threadId":"…","cwd":"…","approvalPolicy":"never","sandbox":"read-only"}}

// turn/interrupt — turn/completed then arrives with status "interrupted"
{"method":"turn/interrupt","id":4,"params":{"threadId":"…","turnId":"…"}}
```

Turn-level overrides (`model`, `effort`, `cwd`, `sandboxPolicy`, `personality`,
`summary`) become defaults for later turns on that thread. `outputSchema` applies
only to the turn it is sent on.

We do not send `serviceName`; the official plugin does. Harmless either way, but
it aids support triage.

### Notifications we act on

`item/completed` is the **authoritative** final state for an item — act on it and
ignore the deltas. `turn/completed` carries `status: "completed" | "interrupted" |
"failed"`.

Item types worth normalising: `agentMessage {id,text,phase?}` (`phase` is
`commentary` or `final_answer`), `commandExecution {id,command,cwd,status,aggregatedOutput?,exitCode?,durationMs?}`,
`fileChange {id,changes:[{path,kind,diff}],status}`, `reasoning`, `mcpToolCall`,
`webSearch`, plus `enteredReviewMode`/`exitedReviewMode`.

Unknown item and notification types must be ignored, not treated as errors — the
union grows between releases. Our `app-server.ts:337-346` already does this
correctly; keep it that way.

## Approvals — the part we currently get wrong

Approvals are **server→client JSON-RPC requests**. The client answers with the
decision as the JSON-RPC `result`, reusing the same `id`.

| Method                                  | Params                                                                                                                                             | Valid results                                                                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `item/commandExecution/requestApproval` | `{itemId, threadId, turnId, reason?, command?, cwd?, commandActions?, proposedExecpolicyAmendment?, networkApprovalContext?, availableDecisions?}` | `"accept"`, `"acceptForSession"`, `"decline"`, `"cancel"`, or `{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":[…]}}` |
| `item/fileChange/requestApproval`       | `{itemId, threadId, turnId, reason?, grantRoot?}`                                                                                                  | `"accept"`, `"acceptForSession"`, `"decline"`, `"cancel"`                                                                      |
| `item/permissions/requestApproval`      | —                                                                                                                                                  | `{permissions, scope:"session"\|"turn"}`                                                                                       |
| `tool/requestUserInput`                 | 1–3 questions, `autoResolutionMs`                                                                                                                  | answers object                                                                                                                 |
| `mcpServer/elicitation/request`         | form / url modes                                                                                                                                   | per docs                                                                                                                       |

**The result is a bare string, not an object.** After answering, expect
`serverRequest/resolved` and then the final `item/completed` with
`status: completed | failed | declined`.

`networkApprovalContext` being present means this is a managed _network_ approval,
grouped by host + protocol + port.

### Our two defects here

1. `app-server.ts:385` returns `{ decision: "denied", reviewDecision: "denied" }`
   — an object, with values that are not in the enum. A real Codex cannot
   deserialise it, so the turn stalls. **The correct denial is the bare string
   `"decline"`.** Use `"decline"` rather than `"cancel"`: `decline` refuses that one
   action and lets the turn continue, `cancel` aborts the turn.
2. `test-support/src/index.ts:104` emits the retired `execCommandApproval`, so no
   test ever exercises the real method names, and nothing validates our reply. That
   is why defect 1 has survived.

What we get **right** and must preserve: the handler denies **every**
server→client request regardless of method name
(`app-server.ts:349-385`), so an unknown or renamed approval method fails closed.
Do not "optimise" that into a method allowlist.

### Why approvals should never fire anyway

We run `approvalPolicy: "never"` plus a narrow sandbox, so Codex should not ask.
The handler is defence in depth — for managed-network prompts and for the case
where a future Codex asks anyway. Both layers matter; neither is sufficient alone.

## Sandbox and approval vocabulary

Three separate value sets that are easy to conflate:

| Where          | Field                                                    | Values                                                                                                                                                                                                                                 |
| -------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thread/start` | `sandbox` (SandboxMode, **hyphenated**)                  | `read-only`, `workspace-write`, `danger-full-access`                                                                                                                                                                                   |
| `turn/start`   | `sandboxPolicy` (object, **camelCase `type`**)           | `{type:"readOnly", networkAccess?}`, `{type:"workspaceWrite", writableRoots?, networkAccess?, excludeSlashTmp?, excludeTmpdirEnvVar?}`, `{type:"dangerFullAccess"}`, `{type:"externalSandbox", networkAccess:"restricted"\|"enabled"}` |
| both           | `approvalPolicy`                                         | `untrusted`, `on-request`, `never`; doc examples also show `unlessTrusted`. `on-failure` is deprecated                                                                                                                                 |
| `config.toml`  | `sandbox_mode`, `sandbox_workspace_write.network_access` | snake_case equivalents                                                                                                                                                                                                                 |

Note `networkAccess` is a **boolean** under `workspaceWrite` but a **string** under
`externalSandbox`. Our `sandbox.ts` only produces the first two policy types and
never `dangerFullAccess`, which is correct and should stay that way.

Beta clients may pass a `permissions` profile id _instead of_ `sandbox` — never
both. We do not use this.

## The `codex exec` fallback

```bash
codex exec --json --skip-git-repo-check -C <cwd> -s <read-only|workspace-write> \
  [-m <model>] [-c <key>=<value>] [--output-schema schema.json] -
```

Pass the prompt on **stdin** with `-` as the positional argument, never in argv.
Progress goes to stderr; the final agent message to stdout. Parse stdout as JSONL:

- `thread.started.thread_id` — capture this; it is the session id
  `codex exec resume` accepts.
- `item.completed` where `item.type === "agent_message"` — the last one is the
  final message.
- `turn.completed.usage` — token accounting.
- `turn.failed` and `error` events — failure.

Event types: `thread.started`, `turn.started`, `turn.completed`, `turn.failed`,
`item.started`, `item.completed`, `error`. Item types are snake_case here
(`agent_message`, `command_execution`, `file_change`, `mcp_tool_call`,
`web_search`, `plan_update`) — note the deliberate contrast with app-server's
camelCase (`agentMessage`, `commandExecution`). Getting these mixed up is an easy
normalisation bug.

**The gap we need to close:** `--sandbox` conveys the mode, but nothing on this
path conveys the network policy, so `networkPolicy` is silently ignored (remediation
P1-5). Add:

```
-c sandbox_workspace_write.network_access=false
```

There is **no official exit-code table** for `codex exec`. Rely on the
`turn.failed`/`error` events plus the process status; do not invent code meanings.

Never use `--full-auto` (deprecated compatibility flag) or `--experimental-json`
(legacy; `--json` is current).

## Identifiers

Keep these strictly separate — conflating them is how resume silently breaks.

| Id                         | Shape           | Where it comes from                        | What accepts it                                                    |
| -------------------------- | --------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| `thread.id`                | UUID            | `thread/start` / `thread/resume` result    | `thread/resume {threadId}`                                         |
| `thread.sessionId`         | UUID            | same result, **read it, do not derive it** | identifies the live session tree root; forks keep the root's value |
| `thread.started.thread_id` | UUID            | `codex exec --json` JSONL                  | `codex exec resume <SESSION_ID>`                                   |
| our `job_…`                | `job_` + 32 hex | this bridge                                | our own tools only                                                 |

App-server threads and CLI sessions share one persisted store — the rollout JSONL
files under `~/.codex/sessions/YYYY/MM/DD/` — and `thread/archive` moves those same
files. The ids are empirically interchangeable, but **the docs never state the
equivalence in one sentence**, so capture and reuse the id each surface gave you
rather than cross-deriving. Our `compatibility.md` should keep saying exactly this.

## Version and capability detection

Do not parse version strings to decide what to send. In order of preference:

1. **Generate bindings per installed CLI.** `codex app-server generate-ts --out
./schemas` (add `--experimental` for gated fields). The official plugin does this
   in its `prebuild`. TypeScript types are deliberately not published as a package.
2. **Probe.** Our `initialize` round-trip before committing to app-server
   (`app-server.ts:147-191`) is the right pattern — keep it.
3. **Guard for `-32601` "unknown method"** and degrade, exactly as the official
   plugin does.

Other error handling worth knowing: `-32001` means "server overloaded, retry
later" — retry with exponential backoff and jitter. On failure Codex emits an
`error` event carrying `codexErrorInfo` (`ContextWindowExceeded`,
`UsageLimitExceeded`, `Unauthorized`, `SandboxError`, …) and then `turn/completed`
with `status: "failed"`. Mapping `codexErrorInfo` onto our typed error codes would
be a real improvement over the current generic failure path.

There is **no shutdown RPC**. Close the transport: end the child's stdin, then
SIGTERM after a grace period. Our `killTree` already does this.

## Auth

| Method            | Command                                                          | Notes                             |
| ----------------- | ---------------------------------------------------------------- | --------------------------------- |
| ChatGPT (default) | `codex login`                                                    | Browser OAuth, subscription usage |
| API key           | `printenv OPENAI_API_KEY \| codex login --with-api-key`          | Stored in `~/.codex/auth.json`    |
| Per-invocation    | `CODEX_API_KEY=… codex exec …`                                   | Preferred in CI                   |
| Enterprise        | `printenv CODEX_ACCESS_TOKEN \| codex login --with-access-token` |                                   |

`codex login status` exits 0 when credentials are present — that is the correct
non-interactive readiness check for `doctor`, and it leaks nothing. Over
app-server, `account/read {refreshToken:false}` returns `requiresOpenaiAuth`.

Treat `~/.codex/auth.json` as a password file: never read, log, or copy it. Never
export `OPENAI_API_KEY`/`CODEX_API_KEY` into an environment that runs
repository-controlled code — which is precisely what this bridge does, so our
`buildChildEnv` allowlist must never forward them.

## Conformance checklist for `fakeCodexAppServer`

A fake that only mirrors our adapter's assumptions cannot catch a protocol
mismatch — it will agree with our bugs. Ours currently does. To be load-bearing,
the fake must **assert against us**, not just answer us.

- [ ] Emits `item/commandExecution/requestApproval` and
      `item/fileChange/requestApproval` — **not** `execCommandApproval` /
      `applyPatchApproval`.
- [ ] **Rejects** a reply that is not one of `accept`, `acceptForSession`,
      `decline`, `cancel`, or the execpolicy-amendment object. This single
      assertion is what turns the fake into a contract.
- [ ] Sends a server request with an **unknown method name** and asserts we still
      deny it (pins fail-closed behaviour).
- [ ] Emits `serverRequest/resolved` then `item/completed` with
      `status: "declined"` after a denial, so we exercise the full sequence.
- [ ] Rejects a `turn/start` that omits `sandboxPolicy`, or whose policy is
      `dangerFullAccess`, or whose `networkAccess` is true when we asked for false.
      This makes the sandbox claim testable rather than assumed.
- [ ] Rejects an `initialize` that omits `clientInfo.name`.
- [ ] Has a variant that **writes a file** into `cwd` before completing, so the
      diff/patch path is exercised (remediation P3-4, and the only way P2-1's
      untracked-file defect becomes visible).
- [ ] Has variants for: `initialize` failure, mid-turn process exit, stderr noise,
      a message split across two writes, a >1 MB single line, and a turn slower
      than the job timeout.
- [ ] Echoes the received `turn/start` input back as the final `agentMessage`, so
      prompt-construction tests can assert the text actually arrived verbatim
      (shell metacharacters included) instead of merely that nothing threw.

## Divergences: this repo vs the protocol

Current as of `cfd5556`. Remediation ids in brackets.

| #   | Our behaviour                                                     | Protocol                                     | Severity                                       |
| --- | ----------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------- |
| 1   | Approval reply `{decision, reviewDecision}` (`app-server.ts:385`) | bare decision string                         | **breaks approvals against a real CLI** [P3-3] |
| 2   | Fake emits `execCommandApproval` (`test-support:104`)             | retired v1 name                              | hides #1 [P3-3]                                |
| 3   | `exec` path sends no network policy (`exec-fallback.ts:104`)      | `-c sandbox_workspace_write.network_access=` | security claim unmet [P1-5]                    |
| 4   | `clientInfo.version` hardcoded `"0.1.0"` (`app-server.ts:449`)    | should be honest                             | cosmetic, feeds compliance logs [P5-5]         |
| 5   | No `capabilities.optOutNotificationMethods`                       | supported, used by the official plugin       | wasted traffic                                 |
| 6   | No `serviceName` on `thread/start`                                | optional                                     | triage friction                                |
| 7   | `adapter.reply()` never called (`job-manager.ts:537`)             | `thread/resume` exists and works             | documented feature absent [P0-5]               |
| 8   | `codexErrorInfo` not mapped to our error codes                    | rich taxonomy available                      | poor diagnostics                               |

## Do not

- Use `codex mcp-server` (deprecated), private/reverse-engineered APIs, UI
  automation, or credentials read out of application storage.
- Hardcode model ids. Observed local config used `gpt-5.6-sol`; these move fast.
  Read the configured default or discover via `model/list`.
- Parse decorative terminal output. Every fact we need is in a JSON line.
- Add a strict `"jsonrpc":"2.0"` presence check — app-server omits it.
- Assume `waiting-for-approval` can occur: with `approvalPolicy: "never"` plus
  auto-deny, that state is unreachable in our design (remediation P4-5).

## Sources

Primary: [`research-codex-2026-08-30.md`](research-codex-2026-08-30.md), which
cites `developers.openai.com/codex/*` (app-server, noninteractive, cli/reference,
config-reference, skills, auth), `github.com/openai/codex`
(`codex-rs/app-server/README.md` is the full protocol reference),
`github.com/openai/codex-plugin-cc` (Apache-2.0; architectural reference only),
and the npm registry. Re-verify before each release and record deviations in
[`compatibility.md`](compatibility.md).
