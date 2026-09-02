# Remediation plan (drafted 2026-09-01, against v0.1.1 @ cfd5556)

This plan turns the findings of the 2026-09-01 repository audit into an ordered
work queue. It is written to be executed top-down: each phase ends in a
verification gate that must pass before the next phase starts.

## How to read this

Every item follows the same shape:

- **Symptom** — the observable wrong behaviour, with `file:line`.
- **Fix** — the smallest correct change.
- **Verify** — the test or command that proves it, and that will fail if the
  defect returns.

Confidence labels are honest about provenance:

- **verified** — traced end to end, or reproduced by running code.
- **reported** — read from the source but not executed; the mechanism checks out.
- **plausible** — depends on an external fact (a vendor CLI's real behaviour)
  that cannot be settled from inside this repository.

## The core diagnosis

The defects are overwhelmingly **not** bad code. They are **missing wiring**.
A correct helper is written, unit-tested in isolation, and then never called by
the production path. The tests pass because they test the helper; the product
bypasses it. The full inventory is in [Appendix A](#appendix-a--dead-and-unwired-code).

The practical consequence for this plan: most fixes are 1–20 lines, because the
correct code already exists. The work is integration and test coverage, not
rewriting.

The second-order consequence is that CI cannot currently detect this class of
defect, because every `JobManager` built in tests injects `selectAdapter`, and
no test imports the CLI at all. Phase 3 exists to close that hole; until it
lands, a green build is weak evidence.

## Baseline (measured, not assumed)

On macOS 23.6 / Node 26.7.0 / npm 11.19.0 / git 2.53.0 at commit `cfd5556`:

| Command                      | Result                                        |
| ---------------------------- | --------------------------------------------- |
| `npm run typecheck`          | pass (but see [P4-3](#p4-3) — it cannot fail) |
| `npm run lint`               | pass                                          |
| `npm run format:check`       | pass                                          |
| `npm run build`              | pass (bundle 193.6 kb)                        |
| `npm test`                   | 64/66 pass                                    |
| `npm run validate:manifests` | pass                                          |

The two test failures were an artefact of a sandboxed home directory, but they
exposed a real defect — see [P3-1](#p3-1).

---

## Phase 0 — Correctness blockers

Nothing else matters until these land. Each one makes a documented, headline
feature either silently wrong or silently absent.

### <a id="p0-1"></a>P0-1 · Partial JSON-RPC lines are dispatched, not buffered · verified

**Symptom.** `JsonLineReader.push()` consumes all complete lines, then
immediately dispatches whatever partial remains and clears the buffer
(`packages/bridge-core/src/jsonrpc.ts:39-44`). `pending` is therefore always
empty when `push()` returns, which makes three things true at once: the class's
documented "incremental line buffering" is false, the size-cap branch at
`jsonrpc.ts:45-49` is unreachable, and `end()` at `jsonrpc.ts:53` is dead code.

`packages/mcp-server/src/serve.ts:269` feeds **raw stdin chunks** into it. Node
reads a pipe in chunks bounded by the 64 KiB stream high-water mark, so any
`tools/call` whose JSON line exceeds that arrives in two or more chunks. Both
halves fail `JSON.parse`, are logged as "malformed JSON on stdin", and **no
response is ever sent** — the calling host hangs on that tool call until its own
timeout. `validateStartRequest` permits a 40 000-character `task` plus 50
constraints of 2 000 characters each, and the Codex skill embeds an entire
handoff plan into `task`, so this is reachable in ordinary use, not a corner case.

The four adapter call sites escape only because `process.ts` pre-splits their
input into whole lines before calling `push()`.

**Fix.** Delete the `jsonrpc.ts:39-44` flush block so `pending` persists across
calls; apply the size cap to the retained buffer; let `end()` handle the final
partial line at EOF. Add an explicit `pushLine(line)` that dispatches directly,
and switch the four pre-split adapter call sites to it so their behaviour is
unchanged and intentional rather than incidental.

**Verify.** A `packages/mcp-server` test that writes a >64 KiB `tools/call` to
stdin in two separate `write()` calls and asserts a well-formed JSON-RPC
response comes back. There is currently no test of any kind for `mcp-server` —
`tests/security/security.test.ts:213` only greps the source for `.listen(`.

### <a id="p0-2"></a>P0-2 · Untrusted repo config reaches `execFile` · verified

**Symptom.** `loadConfig` merges `<repo>/.handoff/config.json` **after** user
config, so the project layer wins (`packages/bridge-core/src/config.ts:118-127`).
`mergeLayer` validates **key names only** and then assigns the value unchecked
(`config.ts:88-99`); `schemas/config.schema.json` is never read at runtime — its
only reference in the repo is `scripts/validate-manifests.mjs:116`.

`cursorBinaryPath` is a known key, so a cloned repository can set it to any
string. That value flows: `packages/cli/src/doctor.ts:448` reads it from the
merged config → `selectCursorAdapter` → `packages/cursor-adapter/src/acp.ts:65`
assigns it to `binaryName` → `acp.ts:84` calls
`execFileAsync(this.binaryName, ["--version"])`.

So cloning a hostile repository and running the very first command the README
recommends — `codex-cursor-bridge doctor` — executes a program that repository
chose. There is no shell involved, so this is not shell injection; it is direct
execution of an attacker-named executable. `codexBinaryPath` is the same story,
and the same layer can also set `allowNonInteractiveCliFallback: true` (the
full-write Cursor mode the docs gate behind an explicit flag),
`defaultPermissionProfile: "current-workspace-write"`, and
`networkPolicy: "allowed"`.

`docs/security-model.md` lists "malicious repository instructions" as a modelled
threat. The config layer is the same threat class, unmitigated and unmentioned.

**Fix.** Two changes, both needed:

1. Treat the project layer as untrusted. Maintain an explicit set of keys
   accepted **only** from user config or CLI flags — at minimum
   `codexBinaryPath`, `cursorBinaryPath`, `allowNonInteractiveCliFallback`,
   `networkPolicy`, `defaultPermissionProfile`, `defaultImplementProfile` — and
   ignore them with a warning when they appear in `.handoff/config.json`.
2. Validate the merged config's **values** against `schemas/config.schema.json`
   (types, enums, ranges), the way `validateStartRequest` already validates tool
   input. Fail closed on violation.

Item 2 independently fixes two more defects: `maxConcurrency: 0` currently
deadlocks the concurrency gate with no timeout so the `tools/call` never returns
(`packages/orchestrator/src/job-manager.ts:98-109`), and
`defaultPermissionProfile: "readonly"` — a plausible typo for `read-only` —
silently yields a workspace-write sandbox on the live tree.

**Verify.** Unit tests: a project config setting `cursorBinaryPath` is ignored
and warned about; a project config with `maxConcurrency: 0`, a bad profile
enum, and `defaultTimeoutMs: 10` is rejected with `BRIDGE_CONFIG_INVALID`.

### <a id="p0-3"></a>P0-3 · The whole `cursor` CLI family runs Codex · verified

**Symptom.** Both CLI families build their request with
`origin: { host: "cli", … }` (`packages/cli/src/index.ts:294`, `:554`).
`targetOf` maps anything that is not literally `"cursor"` or `"codex"` to
`"codex"` (`packages/orchestrator/src/job-manager.ts:601-603`), so `"cli"` falls
through to Codex. `makeManager`'s adapter selection then branches on
`record.targetHost === "codex"` (`index.ts:127`) and builds a Codex adapter.

Net effect: `codex-cursor-bridge cursor start --mode implement --task …`, which
is documented at `README.md:256`, prints `job … queued (cursor)` and runs
**Codex**. Then `cursor list` filters on `j.targetHost === host` (`index.ts:221`)
and reports no jobs — it cannot see the job it just created. Every documented
`cursor` subcommand (`start`, `status`, `result`, `reply`, `cancel`, `list`) is
affected.

Nothing caught this because the demos call `enqueue` with `origin.host: "codex"`
directly (`packages/cli/src/demos.ts:309`), bypassing the CLI entirely, and no
test imports `packages/cli`.

**Fix.** Stop inferring direction from `origin.host`. Either pass the intended
`targetHost` explicitly into `enqueue`, or set `origin.host` to the _opposite_
host of the requested target (`cursor start` → `origin.host: "codex"`). Make
`targetOf` throw on an unrecognised host instead of defaulting, so this class of
mistake fails loudly.

**Verify.** A CLI-level test asserting `cursor start` produces a record with
`targetHost === "cursor"` and that `cursor list` then lists it. Covered by the
tool-router/CLI suite in [P3-2](#p3-2).

### <a id="p0-4"></a>P0-4 · The bundled CLI never runs on Windows · verified

**Symptom.** `packages/cli/src/index.ts:569-571`:

```ts
const isMain =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1]!.split("/").pop() ?? "\u0000");
```

On Windows `process.argv[1]` is a backslash path, so `.split("/")` finds no
separator and `.pop()` returns the entire path. `import.meta.url` is a
forward-slashed `file:///C:/…` URL, so `endsWith` is always false and `main()`
never runs: every documented command prints nothing and exits 0.
`install.ps1:41-45` ships exactly this entrypoint to Windows users.

This also makes five CI steps on both Windows matrix legs vacuous: the bundle
smoke test (`.github/workflows/ci.yml:34`) and all four `demos run` invocations
(`ci.yml:43-46`) exit 0 having done nothing. `npm test` still runs vitest on
those legs, so the Windows matrix is not entirely fake — but everything that
exercises the shipped binary is.

Note the check is loose on POSIX too: it matches by basename, so any script
named `codex-cursor-bridge.mjs` anywhere would satisfy it.

**Fix.** Compare resolved URLs, not basenames:

```ts
import { pathToFileURL } from "node:url";
const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
```

**Fix (CI).** Make the smoke step assert output rather than exit status, e.g.
pipe `--version` through a grep for the expected version string. A step that
cannot fail is not a test.

### <a id="p0-5"></a>P0-5 · `*_reply` never reaches the agent · verified

**Symptom.** `JobManager.reply()` appends the message to `r.followUps` and
returns (`packages/orchestrator/src/job-manager.ts:537-570`). It never resolves
an adapter. `adapter.reply()` on both transports
(`packages/codex-adapter/src/app-server.ts:656`,
`packages/cursor-adapter/src/acp.ts:360`) and the exported
`buildFollowUpPrompt` are reachable **only** from
`tests/protocol/adapters.test.ts:150`.

The CLI path is worse: `packages/cli/src/index.ts:540-565` discards both `host`
and `nativeId` and enqueues a brand-new `mode: "investigate"` read-only job whose
task is just the message, then prints its summary as though it were the
continuation. So `codex reply job_x "also check clock skew"` silently starts a
fresh, context-free thread.

`README.md:216` ("This continues the **same Codex thread** (via
`thread/resume`)") and `docs/compatibility.md:76` are both false today.

**Fix.** Have `JobManager.reply()` resolve the adapter for the stored record and
`await adapter.reply(record.nativeId, buildFollowUpPrompt(message), ctx)`,
persisting the returned `JobResult` and appending a `followUp` event. Replace the
CLI's `managerFollowUp` with a call to `manager.reply(jobId, message)`. Fix both
together — they are one defect with two entry points.

If live continuation is not going to be implemented in this release, delete the
tools and the claims instead; a tool that says "follow-up queued" while queueing
nothing is worse than no tool.

**Verify.** A protocol test where the fake asserts it received a `thread/resume`
with the original `threadId` and a `turn/start` carrying the follow-up text.

### <a id="p0-6"></a>P0-6 · Crash recovery marks live jobs as failed · verified

**Symptom.** `JobRecord` declares `pid?: number | null` and
`pidHostBootId?: string | null` (`packages/bridge-core/src/types.ts:191-192`),
and `schemas/job-record.schema.json:108-109` declares both. The **only**
production write is the literal `pidHostBootId: null` at
`packages/orchestrator/src/job-manager.ts:190`. A real pid is never stored.

`recover()` computes `const pid = workerPids?.get(record.jobId) ?? record.pid ?? null`
and treats `pid === null` as dead (`packages/job-store/src/store.ts:308-310`), so
every non-terminal job it sees is flipped to `failed`. Recovery runs at every MCP
server start (`packages/mcp-server/src/serve.ts:61`) and via `jobs recover`
(`packages/cli/src/index.ts:472`). In the advertised two-plugin setup — a
Cursor-side server and a Codex-side server both running — starting one marks the
other's in-flight jobs failed. `cancel()` then throws `JOB_ALREADY_TERMINAL`
(`job-manager.ts:488-495`), so the still-running job can no longer be stopped.

The severity is bounded: the owning process's `finalize()` is an unguarded write
and will overwrite the bogus `failed` when the job ends. The lasting harm is a
wrong-status window plus an uncancellable live job.

The test passes because it hand-writes `pid: 999999999`
(`tests/integration/job-manager.test.ts:208`) — a value production never
produces. That is the signature of a test written against the helper rather than
the behaviour.

**Fix.** Persist `process.pid` and a boot identifier when the worker starts
running. Treat `pid === null` on a non-terminal record as **unknown**, not dead —
leave the status alone and surface it as a warning. Only mark `failed` when a
recorded pid is confirmed gone _and_ the boot id matches the current boot (pids
are reused across restarts, which is exactly what `pidHostBootId` was declared
for). `isPidAlive` already correctly treats `EPERM` as alive
(`packages/bridge-core/src/process.ts:220-230`).

**Verify.** An integration test that creates a running job with the current
process's pid, runs `recover()`, and asserts the status is **unchanged**; plus
one with a definitely-dead pid asserting it flips to `failed`.

### <a id="p0-7"></a>P0-7 · `background` is advertised, defaulted true, and ignored · reported

**Symptom.** The tool schema advertises "Start as a background job and return the
job id immediately" (`packages/orchestrator/src/tools.ts:69-72`), `enqueue`
records it (`job-manager.ts:129`), and then `tools.ts:205` `await`s
`manager.run()` to completion inside the `tools/call`. `JobManager.run` ignores
its own `_opts.wait` (`job-manager.ts:248-250`).

With `defaultTimeoutMs` at 30 minutes (`packages/bridge-core/src/types.ts:273`),
every `codex_start` / `cursor_start` can block the host's tool call for half an
hour. The host's own tool timeout fires first, and the `jobId` is only present in
the final payload — so a working delegation looks like a failure and the job is
then discoverable only through `*_list`. `README.md:7` sells delegation "as
background jobs" and `README.md:199` documents polling one.

This is the defect most likely to make the product feel broken in real use, and
it was the one the audit's own verification pass surfaced independently.

**Fix.** Honour it: return `{ jobId, nativeId: null, status: "queued" }` straight
after `enqueue`, and let `run()` proceed detached with its result persisted for
`*_status` / `*_result` to collect. Alternatively remove the parameter and the
"returns immediately" language — but then the whole start/poll workflow in the
README has to go too, which is most of the product's value.

**Verify.** A tool-router test asserting `codex_start` with `background: true`
resolves before the fake agent's turn delay elapses, and that `codex_status`
subsequently reports the job.

### Gate 0

- `npm run build && npm test` green.
- New tests from P0-1, P0-3, P0-5, P0-6, P0-7 present and failing before their
  fix, passing after.
- `node bundles/codex-cursor-bridge.mjs --version` prints a version on Windows
  (or in a Windows container / CI leg).

---

## Phase 1 — Make the security claims true

Each item here is a promise in `README.md` or `docs/security-model.md` with no
enforcing code. The choice for every one is the same: implement the control, or
delete the claim. Shipping the claim without the control is the only unacceptable
outcome.

### <a id="p1-1"></a>P1-1 · `mode` and `permissionProfile` are never cross-checked · verified

**Symptom.** `enqueue` only supplies a default profile when none is given
(`packages/orchestrator/src/job-manager.ts:126-129`), and
`validateStartRequest` checks the two fields independently with no cross-field
rule (`packages/bridge-core/src/validate.ts:486-494`) — while `tools.ts:60-61`
advertises the coupling.

So `{ mode: "plan", permissionProfile: "current-workspace-write" }` is accepted:
no worktree is created (`job-manager.ts:310`, `:325`),
`packages/codex-adapter/src/sandbox.ts:44-56` hands Codex `workspaceWrite` with
`writableRoots: [cwd]` on the developer's live tree, and
`packages/codex-adapter/src/prompt.ts:32` simultaneously tells the agent "Mode:
PLAN (read-only). Do not modify any files." The only trace is a
`worktree.skipped` warning. The delegating agent picks the profile, and that
agent is the untrusted input surface the threat model is built around.

**Fix.** Add a cross-field rule in `validateStartRequest`: reject any profile
other than `read-only` for modes `investigate`, `review`, `adversarial-review`,
`plan`, and `rescue`. Decide explicitly whether `implement` + `read-only` is legal
and enforce that decision too.

**Verify.** Security test: every read-only mode paired with each write profile is
rejected with `BRIDGE_USAGE`.

### <a id="p1-2"></a>P1-2 · Path containment is exported, tested, and never called · verified

**Symptom.** `assertInsideRepo`, `assertRepoRelative`, `assertNoSymlinkEscape`,
and `sanitizeBranchName` appear only in their own definitions
(`packages/bridge-core/src/paths.ts`), the barrel re-export, and
`tests/unit/core.test.ts`. No production call site exists.

`validateStartRequest` requires `cwd` to be a non-empty string and nothing more
(`packages/bridge-core/src/validate.ts:483-485`) — not even that it be absolute.
`canonicalize` imposes no containment (`paths.ts:14-22`). That value becomes the
adapter's `cwd` and then `sandbox.ts:47`'s `writableRoots`. A delegating agent can
pass `cwd: "/Users/me"` with `current-workspace-write` and get write authority
across the whole home directory, outside the repository the bridge was started
for. `docs/security-model.md:37-42` and `:59-62` assert these checks are applied
to agent-supplied paths.

**Fix.** Call `assertInsideRepo(repoRoot, request.cwd)` in `enqueue`. If
cross-repository delegation is a real requirement, gate it behind an explicit
config option and log it. Wire `assertNoSymlinkEscape` into worktree target and
patch-path resolution, or delete it and correct the threat model — note that as
written it would false-reject an in-repo file whenever the repo root sits under a
symlink (macOS `/tmp` → `/private/tmp`), so canonicalise root and target the same
way before comparing.

**Verify.** Security tests: `cwd` outside the repo root, `cwd` containing `..`,
and a symlinked `cwd` are each rejected at `enqueue`.

### <a id="p1-3"></a>P1-3 · "Read-only" is unenforced on the Cursor side · verified

**Symptom.** Neither Cursor transport reads `permissionProfile`:
`packages/cursor-adapter/src/acp.ts:151` and `:238-241` never transmit it, and
`packages/cursor-adapter/src/sdk.ts:119-121` uses it only for a display flag. No
worktree is created for read-only jobs (`job-manager.ts:310`), so the agent's
`cwd` is the developer's own tree.

The documented compensating control is unreachable as well: `finalize` skips diff
collection for read-only profiles (`job-manager.ts:417-420`), so the
"read-only job reported changed files" warning at `:461-470` can never fire from
bridge-side data. A read-only Cursor job that modifies the tree completes with
status `completed` and zero warnings.

What _does_ hold is relay-and-deny of `session/request_permission`, which is the
mechanism `docs/security-model.md:133` describes, and `docs/compatibility.md`
already discloses the profile is honoured "via permission requests". The false
statement is `README.md:52-53`: "Investigation/review/plan modes **cannot** modify
your repo."

**Fix.** Pick one, in order of preference:

1. Create a throwaway worktree for ACP/SDK read-only jobs too, so writes land
   somewhere disposable. Reuses `createWorktree`; strongest guarantee.
2. Capture `git status --porcelain` before the run and diff it after for
   non-Codex adapters; populate `changedFiles` from that and fail the job on any
   delta. This also makes the `:461` warning reachable.
3. At minimum, weaken `README.md:53` to describe what is actually enforced per
   transport, and use `local.sandboxOptions.enabled` on the SDK path (see
   [cursor-integration-guide.md](cursor-integration-guide.md)).

Do 1 or 2 **and** 3.

**Verify.** Integration test with a fake ACP agent that writes a file during a
read-only job; assert the job does not report `completed` clean.

### <a id="p1-4"></a>P1-4 · ACP permission denial can select an allow option · verified

**Symptom.** `packages/cursor-adapter/src/acp.ts:191-192`:

```ts
const denyOption =
  options.find((o) => o.kind === "reject_once") ?? options.at(-1);
```

When no option has exactly `kind === "reject_once"`, it selects the **last option
positionally**. If a real agent ever sends options ending in an allow kind, or
offers only `reject_always`, the bridge grants the escalation while
unconditionally recording `decision: "auto-denied"` (`acp.ts:199`). When `options`
is absent it sends `optionId: null`, which is not a valid ACP selection and leaves
the request unresolved. Separately, `acp.ts:209` answers **any** other
server→client method with `{}` — asymmetric with the Codex handler, which
correctly denies unknown methods
(`packages/codex-adapter/src/app-server.ts:349-385`).

Contingent, hence _verified mechanism / plausible exploit_: Cursor's documented
option set and the ACP v1 enum both include a reject option, so today's agent
most likely hits the `find()`. This is a fail-closed-by-luck situation, and it is
the only write control on the ACP path.

**Fix.**

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

Record the `optionId` actually chosen rather than a hardcoded string, and make the
default branch for unrecognised server requests deny and emit an approval event.
Beware the hyphen/underscore split documented in
[cursor-integration-guide.md](cursor-integration-guide.md) — match defensively on
both.

**Verify.** See [P3-3](#p3-3) — the fake must actually send the request.

### <a id="p1-5"></a>P1-5 · The `codex exec` fallback drops the network policy · reported

**Symptom.** `packages/codex-adapter/src/exec-fallback.ts:104-113` builds argv
with `--sandbox <mode>` but nothing conveys `networkAccess`. The
`turnSandboxPolicy` object that `mapProfileToSandbox` computed — including
`networkAccess` — is discarded on this path. So for implement-mode jobs on the
fallback, outbound network is governed by the user's `~/.codex/config.toml`, not
by the bridge. A developer with `network_access = true` gets a networked agent
while `README.md:60` promises `networkAccess=false`; conversely setting
`networkPolicy: "allowed"` silently does nothing here.

**Fix.** Add `-c sandbox_workspace_write.network_access=<bool>` to the argv so one
policy object drives both Codex transports. See
[codex-integration-guide.md](codex-integration-guide.md) for the exact key. Assert
in a test that the flag is present and matches `ctx.networkPolicy`.

### <a id="p1-6"></a>P1-6 · Handoff depth is self-reported by the caller · verified

**Symptom.** `packages/orchestrator/src/job-manager.ts:138` takes the depth
straight from the request: `handoffDepth: request.origin?.handoffDepth ?? 0`, and
`packages/orchestrator/src/tools.ts:104` accepts it as MCP tool input
(`integer, minimum 0, maximum 2`). The check is `if (depth > maxDepth) throw`
(`job-manager.ts:150`). Nothing increments the counter, and `parentJobId` **is**
captured (`job-manager.ts:135-137`) but never used to derive depth.

`maxHandoffDepth` is caller-supplied too, so a caller can raise its own ceiling
to the hard maximum of 2.

So an agent that reaches a bridge MCP server can call `*_start` with
`handoffDepth` omitted, get 0, and pass the check every time. The documented
"depth 1 by default" binds only honest callers. What actually bounds recursion is
(a) the per-host tool router, which genuinely is enforced structurally
(`tools.ts:172-182`; `packages/mcp-server/src/serve.ts:125-129`, `:196-201`), and
(b) `HARD_MAX_HANDOFF_DEPTH = 2`. The counter that
`docs/security-model.md:80-81` credits is decorative.

The passing test proves only the comparison: the demo honestly passes
`handoffDepth: 2` (`packages/cli/src/demos.ts:416`).

**Fix.** Derive depth server-side. `parentJobId` is already there — use it:
`depth = parentJobId ? store.get(parentJobId).handoffDepth + 1 : 0`, ignoring any
caller-supplied value above that floor. For agents that are children of a bridge
job, export `CCB_HANDOFF_DEPTH` / `CCB_PARENT_JOB_ID` through `buildChildEnv`
(`packages/bridge-core/src/process.ts:46-75` already has the forwarding
mechanism) and have the MCP server read them as the floor for incoming requests.
Clamp `maxHandoffDepth` to the configured value, not the hard max.

**Verify.** Security test: a request with `handoffDepth` omitted but a
`parentJobId` pointing at a depth-1 job is treated as depth 2 and rejected under
the default cap.

### Gate 1

For every item: either the control exists and a test proves it, or the claim is
gone from `README.md` and `docs/security-model.md`. Grep both files for
"cannot modify", "capped", "denied by default", and "no network" and confirm each
surviving sentence maps to code.

---

## Phase 2 — Durability and data integrity

### <a id="p2-1"></a>P2-1 · The exported patch omits every new file · reported

`packages/orchestrator/src/worktree.ts:261-269` runs `git diff <baseRef>`, which
excludes untracked files, while `:243-248` adds them to the `files` list anyway.
The implement prompt never asks the agent to commit
(`packages/codex-adapter/src/prompt.ts:72-79`), so new files stay untracked: the
result reports `src/feature.ts` as `added` and the patch does not contain it.
`README.md:184` tells the user to `git apply` that patch, so they apply a silently
half-complete change. `filesChanged` (from `files.length`) also disagrees with the
insertions/deletions taken from `--numstat`.

**Fix.** Run `git add -N .` inside the bridge's own worktree — never the user's
tree — before diffing. **Verify.** [P3-4](#p3-4).

### <a id="p2-2"></a>P2-2 · The worktree base is a moving ref, not a commit · reported

`worktree.ts:125` stores the symbolic ref. Two failures follow. With base `main`,
if the user commits to `main` while the job runs, `git diff main` emits reverse
hunks for those commits — applying the returned patch reverts the user's work.
With base `HEAD` (reached whenever `info.branch` is null, i.e. detached HEAD), the
worktree does `checkout -b`, so `HEAD` inside it is the agent's own branch tip and
anything the agent committed diffs to nothing: `completed`, empty patch, zero
files changed.

**Fix.** Capture the SHA — `git rev-parse --verify <ref>^{commit}` — and store
that commit id as `baseRef`. Argument injection is already blocked because that
same `rev-parse` must resolve before the value reaches `worktree add`
(`worktree.ts:127-144`); keep that ordering.

### <a id="p2-3"></a>P2-3 · Finalize is not idempotent; the transition table is decorative · reported

`assertTransition` and `setStatus` have no production callers — only
`tests/protocol/adapters.test.ts:308-315`. `finalize` writes status raw with no
terminal check (`job-manager.ts:472`) and is called from inside the `try` at
`:366`, so a throw re-enters through the `catch` at `:367` and finalizes a second
time, overwriting `completed` and `diffPatchPath` with a failure result. The
trigger is a store-level exception (a lock failure, `ENOSPC`), not an ordinary
run. `recover()` and `cancel()` do **not** clobber terminal records — they check.

**Fix.** Route every status write through `setStatus`/`assertTransition`, and make
`finalize` a no-op on an already-terminal record, decided inside the `update()`
lock.

### <a id="p2-4"></a>P2-4 · Cross-process cancel reports success and kills nothing · reported

`this.aborts` is per-process (`job-manager.ts:76`), so a fresh CLI process takes
the `else` branch at `:500-511`, writes `status: cancelled`, and returns a
cancelled result. `packages/cli/src/index.ts:421` prints "cancelled". No pid was
ever stored, so nothing can be signalled — while `README.md:225` and
`tools.ts:320` promise process-tree termination. A user cancelling a
`current-workspace-write` job is told it stopped while the agent keeps editing
their tree. Depends on P0-6's pid persistence.

**Fix.** With the pid stored, signal it (SIGTERM, then SIGKILL after the grace
period) using the existing `killTree` logic. If the pid is unknown, fail with an
explicit "job is owned by another process" error instead of claiming success.

### <a id="p2-5"></a>P2-5 · The directory lock does not exclude · reported

`store.ts:249-255` creates the lock directory and _then_ writes the owner payload
— two syscalls, so the window is stealable; `:280-288` steals on an unreadable
owner file; `:257-263` releases without checking ownership; `:276` breaks on age
alone. Downgraded from the original severity because `lock()`'s only caller is
`update()` (`store.ts:190`) and its critical section (`:192-199`) is entirely
synchronous — no lock is ever held across an `await`. Two simultaneous holders
therefore require landing inside a two-adjacent-syscall window or a holder
suspended >30 s.

**Fix (hardening).** Create the lock atomically with its payload:
`fs.writeFileSync(lockFile, owner, { flag: "wx" })`. Verify the owner before
removing it in `release()`. Break only when the recorded owner is confirmed not
alive — age alone must never break a live owner. Add an acquisition timeout.

### <a id="p2-6"></a>P2-6 · Small integrity items · reported

| Item                                                                                                                                                                                                | Location                                  | Fix                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jobId` validated on create but not on read/update, so `codex_status` with `../../..` builds paths outside the state dir                                                                            | `packages/job-store/src/store.ts:51`      | Apply the job-id regex in `jobDir()` so bad ids fail `JOB_NOT_FOUND` before a path is built                                                                                                     |
| No `fsync` before `rename`, so a crash can leave a zero-length `job.json` that `list()` silently skips                                                                                              | `store.ts:94-112`                         | `fsyncSync` the temp fd before rename                                                                                                                                                           |
| Worktrees and `bridge/*` branches leak on the failure path; retention then deletes the only record of them                                                                                          | `store.ts:361`, `worktree.ts:302`         | Remove the worktree on failure when it has no changes; `git worktree prune` in `clean()` before deleting the record                                                                             |
| `jobs clean` hardcodes retention windows and ignores config                                                                                                                                         | `packages/cli/src/index.ts:459`           | Route through `JobManager.clean()`                                                                                                                                                              |
| Handler exceptions inside `JsonLineReader` are caught by the `JSON.parse` try and misreported as malformed JSON; a second throw escapes into the stream `data` listener and can kill the MCP server | `packages/bridge-core/src/jsonrpc.ts:64`  | Parse into a local, dispatch outside the parse `try`, wrap dispatch in its own `try` routed to the logger                                                                                       |
| Transport write failures are swallowed instead of rejecting the in-flight request, turning a dead child into a 30 s timeout paid twice (probe + run)                                                | `jsonrpc.ts:202`                          | Reject the just-registered request when `send` throws; race `initialize` against `child.done`                                                                                                   |
| `child.done` is unhandled during ACP `initialize`, so a spawn failure becomes an unhandled rejection                                                                                                | `packages/cursor-adapter/src/acp.ts:223`  | Attach `.catch()` immediately after `spawnProcess` and include it in the initialize race                                                                                                        |
| No `StringDecoder` in the line splitter, so a multibyte character split across a 64 KiB chunk boundary becomes `U+FFFD` in agent text                                                               | `packages/bridge-core/src/process.ts:145` | Hold a `new StringDecoder("utf8")` per stream. The patch artefact is unaffected — it comes from `execFileAsync`, not this splitter                                                              |
| The 1 MB per-line cap shreds oversized messages into unparsable fragments and makes `maxMessageBytes` unreachable                                                                                   | `process.ts:159`                          | Raise the splitter cap above the reader's cap; on overflow drop the whole logical line and report it through a distinct oversized callback                                                      |
| `Authorization: Basic\|Digest\|ApiKey <cred>` survives redaction — the pattern's `\S+` consumes only the scheme                                                                                     | `packages/bridge-core/src/redact.ts:76`   | Use `[^\r\n]+` like the sibling cookie rules. `Bearer` is already covered by the preceding rule; `isSecretEnvName` has no production caller — wire it into `redactDeep` for key-based redaction |

---

## Phase 3 — Make the test suite load-bearing

The suite is real where it exists — the fakes are genuine child processes over
real stdio pipes (`tests/protocol/adapters.test.ts:58-71`), failure paths assert
specific error codes, and redaction is checked by reading the file back off disk.
The problem is what it does not reach, and one place where it asserts the opposite
of its name.

### <a id="p3-1"></a>P3-1 · Two tests write to the real user state directory · verified

`tests/security/security.test.ts:60` and `tests/contract/handoff.test.ts:78` set
up a `scratch` dir but never set `CCB_STATE_DIR`, so their jobs land in the real
OS state directory (observed: `~/Library/Application Support/codex-cursor-bridge/jobs/…`).
Sibling tests in the same files do set it (`security.test.ts:133`,
`handoff.test.ts:129`). CI never notices because a fresh runner's home is
disposable.

Because the variable is set on `process.env` and never restored, isolation within
a file depends on execution order — adding `.only` or reordering silently changes
which directory a test writes to.

**Fix.** Set `CCB_STATE_DIR` in a `beforeEach` per file and restore it in
`afterEach`, rather than inside individual test bodies.

### <a id="p3-2"></a>P3-2 · Zero coverage on ~2 550 LOC of the most-called code · verified

No test imports `packages/cli`. `buildToolRouter` / `invokeToolSafe` appear only
in `orchestrator/src` and `mcp-server/src`. All six `JobManager` constructions in
tests inject `selectAdapter`
(`job-manager.test.ts:31,88,159,234`; `handoff.test.ts:30,86`;
`security.test.ts:37`), so real adapter selection never runs.
`selectCursorAdapter` and `CursorSdkAdapter` are re-exported by
`tests/helpers.ts:31,34` and never exercised. `doctor` — the primary support
surface, 462 LOC — is only ever run as `doctor --json > /dev/null`
(`ci.yml:68`), output discarded and not even parsed.

`tools.ts` is 399 LOC of input validation, payload shaping, the per-host list
filter (`:354-358`), and `invokeToolSafe`'s never-throw contract. It is the entire
surface both hosts call. P0-3 is exactly the bug a tool-router test would have
caught on day one.

**Fix.** Add two suites:

- **Tool router** — call handlers directly against a `JobManager` with a fake
  adapter: `codex_start` rejects unknown fields with `BRIDGE_USAGE`; `cursor_list`
  returns only `targetHost === "cursor"`; a throwing handler becomes
  `{ ok: false, code }`; the opposite host's tool name is absent.
- **CLI** — `cursor start` targets Cursor; `codex reply` resumes rather than
  starting a new job; `doctor` returns the expected check ids and exits 1 on an
  unwritable state dir.

### <a id="p3-3"></a>P3-3 · The approval tests are tautological · verified

This is the most important item in the phase, because it is the failure mode that
lets everything else hide.

The fakes were written by the same author as the adapters, so a shared
misunderstanding of the real protocol passes every test. Three concrete instances:

1. `packages/test-support/src/index.ts:104` emits **`execCommandApproval`** — a
   method the repository's own research report calls retired
   (`docs/research-codex-2026-08-30.md:152`, "0 hits in the current
   `app-server/README.md`"). The live protocol uses
   `item/commandExecution/requestApproval`.
2. `packages/codex-adapter/src/app-server.ts:385` replies
   `{ decision: "denied", reviewDecision: "denied" }`. The documented reply is a
   **bare decision string** — `"accept" | "acceptForSession" | "decline" | "cancel"`
   (`research-codex-2026-08-30.md:149`). No test asserts the reply shape, so a real
   Codex would receive a result it cannot deserialise and the turn would stall.
3. `fakeCursorAcp` handles `session/request_permission` as an **inbound** method
   (`test-support/src/index.ts:154`) — backwards, since in ACP the _agent_ sends it
   to the client. The fake therefore never sends it, `requestPermission: true` is a
   dead option, and `tests/protocol/adapters.test.ts:189-211` passes
   `requestPermission: true` and then asserts `approvals.length === 0` — the
   opposite of what its name implies. `acp.ts:186-207` has zero execution coverage.

**Fix.** Rebuild both fakes from the research reports and the two new integration
guides, then:

- Codex fake sends `item/commandExecution/requestApproval` and
  `item/fileChange/requestApproval`, and **rejects a reply that is not one of the
  four documented decision strings**. That single assertion converts the fake from
  a mirror into a contract.
- ACP fake sends `session/request_permission` with a realistic `options` array,
  including a variant whose options end with an allow kind, and asserts the
  returned `optionId` is a reject option. This is the test for [P1-4](#p1-4).
- Add a renamed/unknown-method variant to both to pin fail-closed behaviour.

### <a id="p3-4"></a>P3-4 · The central deliverable has no assertions · verified

`tests/integration/job-manager.test.ts:105-119` asserts only that `worktree` is
truthy, that its path contains a substring, and that the origin tree is clean. A
grep across `tests/` for `diffStat`, `patchPath`, `diffPatchPath`, and
`changedFiles` returns nothing. Meanwhile `worktree.ts:292-294` swallows any
collector failure into `filesChanged: 0` / `patchPath: null`, with a second
swallow at `:282-284` — so if diff collection breaks, the job still reports
`completed` and is indistinguishable from a genuinely no-op agent. P2-1 is the
live proof this gap hides a real regression.

**Fix.** An integration test whose fake adapter **writes a file** into `ctx.cwd`
before returning, then asserts `result.diffStat.filesChanged === 1`,
`result.changedFiles` contains it, and the file at `result.diffPatchPath` exists
and is a non-empty unified diff that includes the new file's contents. No current
fake writes files at all, which is why P2-1 survived.

### <a id="p3-5"></a>P3-5 · Spec-required scenarios with no test · reported

Of the 14 protocol scenarios the build spec required, roughly 6.5 have a real
test; of the 12 integration scenarios, about 7. The notable absences:

| Missing scenario                           | Why it matters here                                                                                                                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Partial protocol lines                     | The exact shape of [P0-1](#p0-1)                                                                                                                                                                           |
| Oversized messages                         | Already broken by construction: an over-long line arrives pre-truncated with `…[truncated]` appended, so it is reported as malformed JSON rather than surfacing as oversized. `onOversized` is unreachable |
| Timeouts                                   | `defaultTimeoutMs` and the per-request timeouts are never exercised; add a job with `timeoutMs: 200` against `turnDelayMs: 60000` and assert `timed-out`                                                   |
| Init failure / refusal                     | `failInit` and `refusal` are dead options on the fakes                                                                                                                                                     |
| stderr noise                               | No fake writes to stderr                                                                                                                                                                                   |
| No initial commit                          | `worktree.ts:8`'s doc comment promises warn-and-continue; the code throws and the job fails (`job-manager.ts:367-399`). Pick one behaviour, then test it                                                   |
| Stale lock recovery, concurrent contention | The durability items in Phase 2 have no failing test to fix against                                                                                                                                        |

### <a id="p3-6"></a>P3-6 · CI credibility · verified

Structurally honest — real 3-OS × 2-Node matrix, no `continue-on-error`, no
`|| true`, and `release.yml` re-runs lint, manifests, tests, and checksum
verification before publishing. The gaps are specific:

- **`npm run typecheck` is not in CI at all.** `npm run build` does run `tsc -b`,
  so types are checked, but see [P4-3](#p4-3).
- **`demos run worktree-isolation` is the one demo CI never runs** — the demo that
  proves write isolation, the single most safety-relevant property in the product.
  Add it. I ran it manually and it passes.
- **The demos assert nothing.** `report()` only prints
  (`packages/cli/src/demos.ts:481-484`); demo 4 reports `rejected: false` and
  returns normally (`:421-434`); `runDemos` sets `process.exitCode` only for usage
  errors. Have each demo throw when its asserted boolean is false. Mitigating
  factor: vitest runs first in the same job and does gate the depth cap,
  cancellation, and origin-tree cleanliness — so a regression breaks the build via
  `npm test`, not silently.
- **The demo step commits the working tree** (`git add -A || true; git commit …`,
  `ci.yml:39-41`) to satisfy a clean-tree precondition. That is a workaround for a
  demo requirement rather than a fix; commit `85130ec` is titled after it.
- **Coverage is installed and unused.** `@vitest/coverage-v8` is a devDependency
  with no `test:coverage` script and no threshold. Add both so the 6-test-file /
  11k-LOC ratio has a floor.
- **`tests/e2e/run.mjs` runs in no workflow**, so the only code that would ever
  touch a real CLI is itself unverified — and it asserts by substring on stdout
  (`out.includes('"completed"')`) rather than parsing JSON. Add a
  `workflow_dispatch` job that runs it with the env flags set.

### Gate 3

`npm test` must fail if any Phase 0/1/2 fix is reverted. Verify by reverting one
fix locally and confirming a red build.

---

## Phase 4 — Reconcile the documentation

The docs are unusually honest in the one place it is easiest to cheat:
`docs/compatibility.md:49-50` explicitly marks both Cursor transports "not
installed locally — untested end-to-end", and `README.md:363-366` matches. Keep
that standard and apply it to the rest.

Everything below is a statement that is false as of `cfd5556`.

| #                     | Claim                                                                                                                         | Reality                                                                                                                                                                                                                                                                                                                            | Action                                                                                                                                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P4-1                  | `README.md:382` `npm run demos`                                                                                               | No such script. The real form is `node bundles/codex-cursor-bridge.mjs demos run <name>`, and it throws `ENOENT` on a fresh clone until `.handoff/` exists                                                                                                                                                                         | Add a `demos` script; `mkdirSync` the `.handoff` parent recursively before `mkdtempSync` (`demos.ts:80`)                                                                                                                                  |
| <a id="p4-2"></a>P4-2 | `docs/troubleshooting.md:118` "raw protocol events are then persisted under `<jobDir>/debug/`" and `docs/architecture.md:131` | `debugDir()` (`store.ts:383`) has **zero callers**; nothing is ever written there. `CCB_DEBUG=1` only raises the logger level (`cli/src/index.ts:119`, `serve.ts:52`) — it does _not_ set `config.debugLogging`, which comes only from `--debug` or config. What debug mode really does is emit extra **redacted** per-line events | Delete both claims, or implement the sink routed through `redactString`. Document `CCB_DEBUG` and `--debug` as the distinct things they are. Silver lining: because the raw sink does not exist, no unredacted traffic file exists either |
| <a id="p4-3"></a>P4-3 | `npm run typecheck`                                                                                                           | `tsc -b … --dry \|\| tsc -b …` — `--dry` only reports what _would_ build, and on an up-to-date tree it exits 0, so the `\|\|` never fires. It passes with arbitrarily broken types. `tests/` is type-checked by nothing                                                                                                            | `tsc -b packages/tsconfig.project.json --force`, plus a tsconfig covering `tests/` with `--noEmit`. Add it to `ci.yml`                                                                                                                    |
| P4-4                  | `README.md:355` "Cursor CLI · Minimum tested · 1.0.x"                                                                         | `compatibility.md:49` says untested end-to-end                                                                                                                                                                                                                                                                                     | Retitle the column "Minimum supported" and mark the Cursor rows "documentation/fakes only"                                                                                                                                                |
| P4-5                  | `README.md:297` job lifecycle lists `waiting-for-approval` and `waiting-for-input`                                            | Unreachable: nothing sets either. They exist only in the type union and the store's transition table, and approvals are auto-denied by design                                                                                                                                                                                      | Drop them from the documented lifecycle, or implement them                                                                                                                                                                                |
| P4-6                  | `delegate-to-codex/SKILL.md:87` points at `references/task-templates.md`                                                      | File does not exist (only `modes.md`, `prompt-injection.md`, `troubleshooting.md`)                                                                                                                                                                                                                                                 | Remove the pointer or add the file                                                                                                                                                                                                        |
| P4-7                  | `SKILL.md:39` refers to "`codex-cursor-bridge` plan tooling"                                                                  | The CLI has no `plan` command                                                                                                                                                                                                                                                                                                      | Remove or implement                                                                                                                                                                                                                       |
| P4-8                  | `README.md:344` uninstall snippet                                                                                             | Uses `jq`, never listed as a requirement; `npm run package` needs `zip`, also undeclared                                                                                                                                                                                                                                           | List both under Requirements, or drop the dependency                                                                                                                                                                                      |
| P4-9                  | `CCB_CODEX_BINARY` / `CCB_CURSOR_BINARY`                                                                                      | Read by the code (`config.ts:140-143`, `acp.ts:67`, `cli-fallback.ts:62`) and documented nowhere. These are the first thing a user needs when a binary is off `PATH`                                                                                                                                                               | Document all four `CCB_*` variables and the config precedence order. `README.md:128` currently points at `docs/architecture.md` "for the full schema", which documents no config keys at all                                              |
| P4-10                 | `docs/architecture.md:151` "handoff plans are validated before execution"; `SKILL.md:41`; `CHANGELOG.md:38`                   | `validateHandoffPlan` has no production caller; a malformed plan — including absolute paths in `allowedPaths`, which the schema forbids — is embedded verbatim into the task string and executed                                                                                                                                   | See [P2-7](#p2-7) below; until then the claim must go                                                                                                                                                                                     |
| P4-11                 | `worktree.ts:8` module comment                                                                                                | Promises warn-and-continue for a repo with no initial commit; the code throws                                                                                                                                                                                                                                                      | Correct the comment or add the fallback                                                                                                                                                                                                   |

### <a id="p2-7"></a>P2-7 · Wire the plan validation gate

Deferred here because it is a design decision, not a bug fix. `validateHandoffPlan`
exists, is unit-tested (`tests/contract/handoff.test.ts:117` re-tests the pure
function), and is never called. The honest options are:

1. Accept an optional structured `plan` object on `*_start`, run
   `validateHandoffPlan`, and reject before `enqueue`. This is what the docs
   describe and what the project's name implies.
2. Declare the schema advisory, delete the "validated before execution" language
   from `architecture.md`, `SKILL.md`, `plan-guide.md`, and `CHANGELOG.md`, and
   keep the planner model's self-review as the only check.

Option 1 is the better product. Either way `validateJobResult` should be called in
`finalize` before persisting, so adapter contract regressions surface instead of
shipping silently. The schema itself is good work — all 15 spec-mandated fields
are present with real bounds and `additionalProperties: false`, mirrored exactly
by `types.ts:221-242`.

---

## Phase 5 — Packaging and install

### <a id="p5-1"></a>P5-1 · Neither installer can install the plugins · reported

`scripts/install.sh:13` sets `SCRIPT_DIR` to its own directory and `:101-102`
reads `${SCRIPT_DIR}/../../plugins`, but `scripts/package-release.mjs:49-67`
stages `install.sh` flat inside `codex-cursor-bridge/` next to the bundle — so the
path escapes the archive, `install_plugin` hits its failure branch at `:84`, and
`set -euo pipefail` aborts _after_ the CLI has already been copied. Run from the
repo instead, the same path resolves to the parent of the repo root.
`README.md:98-99` and `:116` promise the installer does this, and both plugin
READMEs repeat it.

Against the four installer requirements — idempotent, `--dry-run`, no shell
assumption on Windows, back up before overwrite — `install.ps1` meets one:
`install.ps1:45`'s `Copy-Item` sits outside `Invoke-Step` (`:18-22`), so
`-DryRun` **writes**; and `:66`'s `Copy-Item -Recurse -Force` overwrites a plugin
directory with no backup, where `install.sh:86-89` correctly renames to `.bak`
first.

**Fix.** Ship the plugin directories inside the CLI archive and resolve them
relative to the archive root; use `${SCRIPT_DIR}/../plugins` for repo runs. Route
every mutation in `install.ps1` through `Invoke-Step`, and rename-to-`.bak` before
any `-Force` copy. Add an archive-extraction smoke test to
`package-validation` that runs `install.sh --dry-run` and then a real install into
a temp `--bin-dir`.

### <a id="p5-2"></a>P5-2 · No documented way to register the MCP server with Codex · plausible

`plugins/codex-plans-cursor-executes/.codex-plugin/plugin.json` has no `mcp` key,
while the Cursor manifest declares `mcpServers`
(`.cursor-plugin/plugin.json:13-20`). A repo-wide grep finds zero `codex mcp add`
and one prose mention of `mcp --host codex` (plugin README:32).
`README.md:112-116` "Installation for Codex" is copy-plugin-then-doctor, after
which the skill immediately calls `cursor_start` (`SKILL.md:45`) — a tool nothing
has registered. `doctor`'s check ids cover node/git/codex/cursor/state only, so it
cannot notice.

Marked _plausible_ because whether Codex's plugin loader can declare or
auto-discover an MCP server from its manifest cannot be settled from inside this
repository — that decides between "undocumented step" and "impossible".

**Fix.** Determine it against the current Codex plugin schema. If the manifest
supports it, declare the server there. If not, document the explicit
`codex mcp add codex-cursor-bridge -- codex-cursor-bridge mcp --host codex` step in
both READMEs and add a `doctor` check for registration. Either way the
Codex→Cursor half of the product currently has no working documented install path,
which makes this a release blocker despite the uncertainty.

### <a id="p5-3"></a>P5-3 · Release packaging is neither idempotent nor deterministic · reported

`scripts/package-release.mjs:38` does not clear `release/` first, so re-running
after deleting or renaming a plugin file ships the deleted file anyway, and
`SHA256SUMS` lists stale artefacts from previous versions as part of this release.
`zip -X` is not used, so archives carry extra fields and are not byte-reproducible
across machines — while `docs/release.md:42-46` advertises a determinism
guarantee.

**Fix.** Delete `release/` at the start of the run; write archives with `zip -X`
into a cleared path (or a Node zip writer, which also removes the undeclared `zip`
dependency); hash only artefacts produced in this run.

### <a id="p5-4"></a>P5-4 · `demos run worktree-isolation` is not idempotent · verified

The demo uses a hardcoded job short id, so it creates branch
`bridge/<repo>-demo3aaa` every time. The first run succeeds and leaves the branch
behind (correctly — the spec forbids automatic branch deletion). The second run
fails: `WORKTREE_CREATE_FAILED: … a branch named 'bridge/…-demo3aaa' already
exists`, exit code 1.

Reproduced directly. The failure is **safe** — typed error, non-zero exit, the
existing branch untouched, working tree clean — so the "never overwrite an existing
branch" invariant genuinely holds. The defect is the fixed name.

**Fix.** Derive the demo's short id randomly, as real jobs do, or delete the
branch in demo teardown. Then add the demo to CI ([P3-6](#p3-6)).

### <a id="p5-5"></a>P5-5 · Housekeeping

- `biome.jsonc` is dead config: `@biomejs/biome` is in no dependency list and a
  repo-wide grep hits only that file, while CI runs eslint + prettier. A
  contributor with the Biome editor extension gets format-on-save from Biome —
  which does not read `.prettierrc.json`'s `endOfLine` — and then fails
  `format:check` with no explanation. `CONTRIBUTING.md:45` never mentions it.
  Delete it, or commit to Biome and remove eslint/prettier.
- `.gitignore` lists `.handoff/` twice (lines 14 and 34), and line 15's
  `!handoff/.gitkeep` is missing the leading dot and refers to a path that does not
  exist.
- `packages/codex-adapter/src/app-server.ts:449` hardcodes
  `clientInfo.version: "0.1.0"` while the package is at 0.1.1 and
  `BRIDGE_VERSION` exists in `types.ts:9`. `clientInfo.name` feeds OpenAI
  compliance logs, so it should be accurate — use the constant.

---

## Appendix A — Dead and unwired code

The single most useful artefact of the audit. Every entry is code that exists, is
usually correct, and is never reached by the production path. Fixing the wiring
resolves most of this plan.

| Symbol / field                                                                          | Defined at                                                         | Reached from                               | Consequence                                                       |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------ | ----------------------------------------------------------------- |
| `assertInsideRepo`, `assertRepoRelative`, `assertNoSymlinkEscape`, `sanitizeBranchName` | `bridge-core/src/paths.ts`                                         | tests only                                 | [P1-2](#p1-2): `cwd` is unbounded                                 |
| `assertTransition`, `setStatus`                                                         | `job-store/src/store.ts:392`                                       | tests only                                 | [P2-3](#p2-3): the state machine is decorative                    |
| `validateHandoffPlan`                                                                   | `bridge-core/src/validate.ts`                                      | tests only                                 | [P2-7](#p2-7): the "validated handoff" is not validated           |
| `validateJobResult`                                                                     | `bridge-core/src/validate.ts:385`                                  | nothing                                    | Adapter contract regressions ship silently                        |
| `adapter.reply()`, `buildFollowUpPrompt`                                                | `app-server.ts:656`, `acp.ts:360`, `codex-adapter/src/index.ts:22` | one test                                   | [P0-5](#p0-5): `*_reply` is a no-op                               |
| `record.pid`, `record.pidHostBootId`                                                    | `types.ts:191-192`, `job-record.schema.json:108`                   | written as `null` only                     | [P0-6](#p0-6): crash recovery inverts; [P2-4](#p2-4): cancel lies |
| `debugDir()`                                                                            | `store.ts:383`                                                     | nothing                                    | [P4-2](#p4-2): documented debug sink does not exist               |
| `JsonLineReader.end()`, the `maxBytes` branch                                           | `jsonrpc.ts:45`, `:53`                                             | unreachable by construction                | [P0-1](#p0-1)                                                     |
| `onOversized`                                                                           | `jsonrpc.ts:15`                                                    | unreachable — the splitter truncates first | Oversized messages surface as malformed JSON                      |
| `isSecretEnvName`                                                                       | `redact.ts:174`                                                    | nothing                                    | Key-based redaction never happens                                 |
| `background`                                                                            | `tools.ts:69`, `job-manager.ts:129`                                | recorded, never honoured                   | [P0-7](#p0-7)                                                     |
| `_opts.wait`                                                                            | `job-manager.ts:248`                                               | ignored                                    | Same                                                              |
| `config.schema.json`                                                                    | `schemas/`                                                         | `validate-manifests.mjs` only              | [P0-2](#p0-2): config values unchecked at runtime                 |
| `turnSandboxPolicy.networkAccess` on the exec path                                      | computed in `sandbox.ts`                                           | discarded in `exec-fallback.ts`            | [P1-5](#p1-5)                                                     |
| `parentJobId`                                                                           | `job-manager.ts:135`                                               | stored, never used to derive depth         | [P1-6](#p1-6)                                                     |
| `failInit`, `refusal`, `requestPermission`, oversized options on the fakes              | `test-support/src/index.ts:72`, `:127`                             | never triggered                            | [P3-3](#p3-3), [P3-5](#p3-5)                                      |

## Appendix B — Suggested sequencing

Phases are ordered by risk, but the dependency graph allows parallelism:

- **Independent, start immediately:** P0-1, P0-2, P0-4, P3-1, P4-\* (docs), P5-\*.
- **P0-6 (persist pid) unblocks** P2-4 (cross-process cancel).
- **P0-3 and P0-5 are both fixed by, and verified with, the CLI suite in P3-2** —
  do them together.
- **P3-3 (honest fakes) should land before P1-4**, so the ACP deny fix has a test
  that can fail.
- **P2-1 needs P3-4's file-writing fake** to be provable.

A reasonable first pull request: P0-1 + P0-4 + P3-1 + the `demos` script and
`.handoff` mkdir from P4-1. All are small, independent, and each closes a hole that
currently makes CI or local testing untrustworthy.

## Appendix C — What not to change

Verified as genuinely correct; do not refactor these while fixing the above.

- `spawnProcess`: argv arrays, `shell: false`, POSIX detach + negative-pid
  SIGTERM→SIGKILL, Windows `taskkill /T /F`, prompts over stdin
  (`bridge-core/src/process.ts:82-136`). Zero `shell: true` / `execSync` in the
  repo.
- `buildChildEnv`: a real allowlist — children do not inherit `process.env`
  (`process.ts:46-75`).
- Codex sandbox mapping: never emits `danger-full-access`, pins `writableRoots` to
  the job cwd, sends `approvalPolicy: "never"` and `networkAccess: false`
  (`codex-adapter/src/sandbox.ts`, `app-server.ts:508-536`).
- Codex approval handler fails **closed for any method name**, including unknown
  ones (`app-server.ts:349-385`) — only the reply _shape_ is wrong.
- `JsonRpcConnection` correlation: timers cleared on resolve/reject/close,
  `close()` rejects every pending entry, unknown response ids ignored
  (`jsonrpc.ts:246-282`).
- Per-host tool routing: structurally enforced, not a runtime check
  (`tools.ts:172-182`, `serve.ts:125-129`).
- No destructive git verbs anywhere in `packages/*/src` — only
  `worktree add --detach`, `checkout -b` inside the new worktree, and
  `worktree remove`.
- Zero `console.*` in `packages/*/src`, so MCP stdout framing is safe; the logger
  writes to stderr and the state log only.
- `0600` / `0700` file modes are really applied (observed on an exported patch).
- Worktree isolation works: the original tree is untouched, and a branch collision
  fails closed with a typed error.
- `docs/compatibility.md`'s honesty about untested Cursor transports. Preserve that
  standard.
