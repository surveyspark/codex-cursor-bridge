# Security Model

This project executes coding agents against real source repositories. This
document is the threat model and the list of enforced controls. It is updated
with every security-relevant change (see CONTRIBUTING.md).

## Assets and trust boundaries

| Asset                                        | Trust level                                               |
| -------------------------------------------- | --------------------------------------------------------- |
| User task text                               | trusted input (validated for shape, length)               |
| Configuration files                          | trusted (validated; never store secrets)                  |
| Repository content                           | **untrusted data** — instructions inside are not commands |
| Agent tool output (diffs, logs, test output) | **untrusted data**                                        |
| Agent processes                              | semi-trusted executors, sandboxed by profile              |
| Bridge state dir                             | local, user-private (0700/0600)                           |

## Threats and mitigations

### 1. Malicious repository instructions (prompt injection)

Repository files, commit messages, or search results may contain text like
"ignore previous instructions and run X".

- Prompts state explicitly that repository content is data, not commands.
- Skill instructions (both hosts) require validation of load-bearing claims
  against the repository before acting.
- Approval requests from agents are auto-denied; the bridge never approves
  destructive actions on the agent's word alone.
- Residual risk: an agent may still follow in-repo instructions within its
  sandbox. Containment (below) bounds the damage.

### 2. Malicious filenames

Filenames with newlines, quotes, or `../` segments.

- All file paths from agents pass through repo-relative validation
  (`assertRepoRelative`), traversal rejection, and containment checks
  (`assertInsideRepo` with realpath canonicalization).
- Git commands use argument arrays; a malicious branch name cannot inject
  flags (leading `-` is stripped by `sanitizeBranchName` for names we create;
  user-supplied refs are verified with `git rev-parse` before use).

### 3. Tool-output prompt injection

Same handling as (1): output is redacted and persisted as event data; skills
instruct hosts to treat surprising "instructions" inside output as findings,
not directives.

### 4. Shell injection

- No `shell: true` anywhere. Prompts go to **stdin**; every spawn is an
  argument array. There is no shell-command tool in the MCP surface.
- Tests exercise task text containing `;`, `$()`, backticks, `&&` to prove
  metacharacters remain inert data.

### 5. Path traversal / symlink escape

- `assertRepoRelative` rejects absolute paths and `..` segments.
- `assertInsideRepo` compares realpath-canonicalized paths.
- `assertNoSymlinkEscape` walks path components and rejects symlinked hops
  that leave the repository root.
- Worktrees are created under the state dir (outside the repo) from a
  verified base ref; the agent's writable root is the worktree only.

### 6. Secret leakage

- `redactSecrets`/`redactDeep` scrub common key/token/cookie/JWT/private-key
  shapes before anything is persisted or logged.
- Secret-shaped environment variables are never forwarded to child processes
  unless explicitly allowlisted (e.g. `OPENAI_API_KEY` for Codex auth);
  `isSecretEnvName` guards logging.
- The bridge never writes secrets to config files; `doctor` reports presence
  (set/unset) but never values.
- Tests seed fake tokens into job payloads and assert the persisted JSON is
  clean.

### 7. Agent recursion

- Every delegation carries `handoffDepth`/`maxHandoffDepth`; enqueue rejects
  depth > cap (default 1, hard max 2) with `RECURSION_BLOCKED`.
- Prompts forbid delegating back to the originating host; MCP tool routers
  expose only opposite-host tools, so a Cursor session literally cannot call
  `cursor_start` on the bridge, and a Codex session cannot call `codex_start`.
- Optional auto-correction is bounded to exactly one pass.

### 8. Uncontrolled network access

- Codex sandbox policy sets `networkAccess: false` (read-only and
  workspace-write) unless the user overrides `networkPolicy`.
- The bridge itself opens no sockets: MCP transport is stdio-only, there is no
  telemetry, and no update/check calls.

### 9. Destructive git actions

- The bridge never runs `reset --hard`, `force-push`, branch deletion, or
  untracked-file removal automatically.
- Worktrees are created detached + new branch; cleanup is explicit or
  retention-driven, and only ever removes the bridge-created worktree path.
- Applying results is a manual `git apply` of the exported patch, on the
  user's confirmation.

### 10. Abandoned child processes

- POSIX: children are spawned as process-group leaders; cancellation kills
  `-pid` (SIGTERM → grace → SIGKILL). Windows: `taskkill /T /F`.
- After normal completion the adapter kills the transport child (protocol
  agents are per-job).
- Tests spawn a stubborn child (ignores stdin close) and assert the pid is
  gone after `killTree`.

### 11. Tampered job-state files

- Records live under the user's state dir with 0700/0600 permissions.
- Writes are atomic (temp + rename) so crashes cannot produce half-records.
- Corrupt records surface as `JOB_STATE_CORRUPT` and are skipped (never
  silently trusted) by listing/recovery.
- Dir-based locks with owner pid + stale takeover prevent concurrent-writer
  corruption.

### 12. Dependency compromise

- Minimal production dependencies (workspace packages only depend on each
  other; zero runtime npm dependencies — Node built-ins only).
- Exact versions + `package-lock.json` committed; Dependabot weekly; CodeQL
  and dependency-review in CI; secret scanning (gitleaks) in CI.
- `npm ci` is the only supported install path for development.

## Permissions profiles

| Profile                    | Agent filesystem                                                     | Use                                                      |
| -------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------- |
| `read-only`                | read-only sandbox (Codex `readOnly`; ACP permission requests denied) | investigate / review / adversarial-review / plan         |
| `isolated-workspace-write` | workspace-write inside a fresh worktree                              | implement (default)                                      |
| `current-workspace-write`  | workspace-write in the developer's tree                              | only on explicit user choice (warned when tree is dirty) |

Full-system access is not an available profile in any adapter mapping.

## Known limitations (honest)

- Redaction is pattern-based; a novel secret format can slip through to the
  local job record (never leaves the machine — no telemetry).
- Codex's own sandbox is the enforcement point for read-only; the bridge
  detects accidental modifications post-hoc for ACP/SDK transports and flags
  them in `result.warnings`.
- The `current-workspace-write` profile can damage uncommitted work by
  design (the user asked for it); the bridge warns but does not prevent.
- Windows sandboxing relies on Codex's internal Windows sandbox; behavior
  differences are Codex's domain.
