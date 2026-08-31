# Troubleshooting

Quick diagnosis: `codex-cursor-bridge doctor` (add `--json` for machines).
Exit code 1 means at least one blocking failure; each ✗ line has a `→`
remediation.

## Codex side

### `ADAPTER_NOT_AVAILABLE` on Cursor→Codex jobs

- `codex` not installed → `npm i -g @openai/codex`.
- Not logged in → `codex login`, or
  `printenv OPENAI_API_KEY | codex login --with-api-key`.
- `codex.app-server` check fails → run `codex app-server` manually; invalid
  `~/.codex/config.toml` keys are a common cause (`codex doctor` helps).

### Job finishes but Codex "did nothing"

Check `codex-cursor-bridge codex result <jobId>`: read-only jobs cannot write
files by design. If you wanted changes, re-run with `--mode implement`
(worktree) — not by loosening the read profile.

### Escalation requests denied

Codex runs with `approvalPolicy=never` inside a narrow sandbox; requests to
escape it (network, writes outside the workspace) are auto-denied and logged
in the job's `approvals`. Narrow the task instead.

### Slow jobs / timeouts

Default timeout is 30 min (`defaultTimeoutMs`). `codex status <jobId>` shows
`deadlineAt`. Re-run with `--timeout <ms>` or split the task.

## Cursor side

### `ADAPTER_NOT_AVAILABLE` on Codex→Cursor jobs

- No transport available. Best path: install the official Cursor CLI —
  `curl https://cursor.com/install -fsS | bash` (Windows:
  `irm 'https://cursor.com/install?win32=true' | iex`) — then `agent login`
  (ACP uses your existing Cursor login). The binary is `agent`; there is no
  official npm package for it.
- SDK path: `npm i -g @cursor/sdk` + set `CURSOR_API_KEY` (cloud agents;
  billing per Cursor docs).
- `cursor.cli-fallback` exists but is gated; enable
  `allowNonInteractiveCliFallback: true` in `.handoff/config.json` only if you
  accept that non-interactive Cursor has full write access.

### `ADAPTER_UNSUPPORTED_CAPABILITY`

The installed `@cursor/sdk` doesn't expose the surface the bridge expects
(attach-by-id for follow-ups, etc.). The selector falls back to ACP; if you
forced `preferredCursorAdapter: "sdk"`, unset it or update the SDK.

### Cursor job touched files outside `allowedPaths`

Reported in `result.warnings` and as deviations in the summary. Treat as a
finding: review the patch before applying; tighten `allowedPaths` in the plan.

## Jobs & state

### Where is my job data?

`doctor` prints the state root (macOS:
`~/Library/Application Support/codex-cursor-bridge`, Linux:
`~/.local/state/codex-cursor-bridge`, Windows: `%LOCALAPPDATA%`). Patches go
to `<repo>/.handoff/`.

### Recover after crash/reboot

`codex-cursor-bridge jobs recover` marks non-terminal jobs whose worker pid
is gone as `failed` (the record explains it). Finished jobs are listed by
`jobs list`.

### Stale lock errors (`JOB_LOCKED`)

A previous bridge process died holding a dir-lock. Locks self-heal after the
stale timeout (30s) or immediately when the owner pid is gone; remove
`<stateRoot>/jobs/<jobId>/.lock` manually only as a last resort.

### Clean up old jobs

`codex-cursor-bridge jobs clean [--dry-run]` — completed jobs default to 7
days, failed ones 14 (`completedRetentionDays` / `jobRetentionDays`).

## Plugin installation

### Cursor doesn't show the plugin

- Local plugins live in `~/.cursor/plugins/local/<name>` (install.sh does
  this). Restart Cursor after install. Verify the skill appears in the agent
  skills list; commands appear in the slash menu.
- The CLI path in `.cursor-plugin/plugin.json` (`codex-cursor-bridge`) must be
  on PATH, or edit the `command` to the absolute `codex-cursor-bridge.mjs`
  bundle path.

### Codex doesn't show the plugin

- Plugin dir: `~/.codex/plugins/codex-cursor-bridge` with
  `.codex-plugin/plugin.json`. Verify with `codex plugin list`.

## Worktrees

### `WORKTREE_EXISTS`

A previous job left a worktree with the same name. Remove it explicitly:
`git worktree list` → `git worktree remove <path>` (bridge worktrees live
under the state `worktrees/` dir). The bridge never removes worktrees on its
own before retention.

### `WORKTREE_CREATE_FAILED: repository has no commits`

Worktree isolation needs at least one commit. Make an initial commit or
explicitly choose `current-workspace-write`.

## Debug logging

Set `debugLogging: true` (config) or `CCB_DEBUG=1`; raw protocol events are
then persisted under `<jobDir>/debug/` and stderr lines are kept. Logs are
redacted, but review before sharing.
