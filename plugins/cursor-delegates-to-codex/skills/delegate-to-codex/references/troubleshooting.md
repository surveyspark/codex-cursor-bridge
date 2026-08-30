# Troubleshooting Codex delegations

## `codex_start` returns `ADAPTER_NOT_AVAILABLE`

- Run `codex-cursor-bridge doctor`. Check `codex.cli`, `codex.app-server`,
  and `codex.auth` lines.
- Not installed: `npm i -g @openai/codex`.
- Not logged in: `codex login` (ChatGPT) or
  `printenv OPENAI_API_KEY | codex login --with-api-key`.
- app-server probe fails: run `codex app-server` manually; check
  `~/.codex/config.toml` for invalid keys (`codex doctor` also diagnoses this).

## Job stuck in `waiting-for-approval`

The bridge denies Codex escalation requests by design (sandbox escapes,
out-of-scope writes). The job continues with the request denied; if the agent
cannot proceed it will finish with blockers. Narrow the task instead of
loosening the sandbox.

## Job timed out

Default timeout is 30 minutes. For long investigations restart with
`timeoutMs` raised, or split the task. `codex_status` shows `deadlineAt`.

## Follow-up fails with "no native session id"

The job failed before Codex reported a thread id. Start a new job; include
the earlier context in the new task.

## Where state lives

- Job records: OS state dir (`doctor` prints it; macOS:
  `~/Library/Application Support/codex-cursor-bridge`, Linux:
  `~/.local/state/codex-cursor-bridge`, Windows: `%LOCALAPPDATA%`).
- Patches/artifacts: `<repo>/.handoff/`.
- Raw protocol logs only when debug logging is enabled.

## Recovery after the editor closes

Job records persist. After reopening, `codex-cursor-bridge jobs list` shows
finished jobs; `jobs recover` marks orphaned ones failed. Continue a Codex
thread with `codex_reply` (same native id) — Codex sessions are recorded under
`~/.codex/sessions` and resumable via `codex resume` as well.
