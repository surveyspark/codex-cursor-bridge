# Cursor adapter selection and troubleshooting

The bridge selects the Cursor transport in this order:

1. **SDK** (`@cursor/sdk` + `CURSOR_API_KEY`) — server-side agents API.
   Requires the package installed and the key set. Key value is never logged.
2. **ACP** (`cursor-agent acp`) — official Agent Client Protocol over stdio,
   authenticated with your existing Cursor login. Structured events; session
   ids preserved; permission requests relayed (the bridge denies escalations).
3. **CLI fallback** (`cursor-agent --print`) — gated behind explicit opt-in
   (`allowNonInteractiveCliFallback` config or `--allow-noninteractive-cli`).
   Official docs: non-interactive mode has FULL WRITE ACCESS — treat as last
   resort.

`cursor-cursor-bridge doctor` (or the bridge `doctor`) reports which adapter
is available and which would be selected.

## Problems

### `ADAPTER_NOT_AVAILABLE` on `cursor_start`

- No Cursor CLI: install the official one — `curl https://cursor.com/install
-fsS | bash` — then `agent login`. The binary is `agent`; `cursor-agent` on
  npm is an unrelated third-party package.
- ACP probe fails: run `cursor-agent acp` manually; check login state.
- SDK path: `npm i -g @cursor/sdk` and set `CURSOR_API_KEY` (billing applies
  per official Cursor docs; the bridge never prints the key).

### Job stuck / no result

`cursor_status` shows the state; `deadlineAt` shows the timeout. Cancel with
`cursor_cancel` (kills the process tree) and re-delegate a narrower task.

### Follow-up rejected

Follow-ups continue the same ACP/CLI session. If the native session id was
never captured (early failure), start a new job with context in the task.

## State locations

- Jobs: OS state dir (see `doctor` output).
- Patches: `<repo>/.handoff/`.
- Worktrees: state dir `worktrees/` (never inside your repo).
