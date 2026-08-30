# codex-cursor-bridge — Cursor plugin

Delegate hard work from Cursor to Codex as managed background jobs.

This plugin packages:

- **Skill** `delegate-to-codex` — mode selection (investigate / review /
  adversarial-review / rescue / plan / implement), precise task composition,
  result validation, follow-ups, and cancellation.
- **Commands** — `/setup-check`, `/delegate-to-codex`, `/review-with-codex`,
  `/adversarial-review-with-codex`, `/rescue-with-codex`,
  `/implement-with-codex`, `/codex-job-status`, `/codex-job-result`,
  `/reply-to-codex`, `/cancel-codex-job`.
- **MCP server** `codex-cursor-bridge mcp --host cursor` — exposes ONLY Codex
  tools (`codex_start`, `codex_status`, `codex_result`, `codex_reply`,
  `codex_cancel`, `codex_list`).

## Prerequisites

- Node.js >= 20.19
- Codex CLI installed and logged in (`npm i -g @openai/codex && codex login`)
- The bridge CLI on PATH (`codex-cursor-bridge`), or the MCP `command` in
  `plugin.json` pointed at the bundled `codex-cursor-bridge.mjs`.

## Install

From a release archive (recommended):

1. Unzip `codex-cursor-bridge-cli-<ver>.zip` and run `./install.sh`
   (`--dry-run` to preview; `install.ps1` on Windows).
2. Unzip `codex-cursor-bridge-plugin-cursor-<ver>.zip` into
   `~/.cursor/plugins/local/codex-cursor-bridge` (or let install.sh do it).
3. Restart Cursor; verify with `/setup-check` or `codex-cursor-bridge doctor`.

From source:

```bash
git clone https://github.com/surveyspark/codex-cursor-bridge.git
cd codex-cursor-bridge && npm ci && npm run build
ln -s "$PWD" ~/.cursor/plugins/local/codex-cursor-bridge
```

## Security posture

- Read-only by default; writes require implement mode + a profile.
- Implementation jobs run in an isolated git worktree and return a patch;
  nothing is merged automatically.
- Codex runs with `approvalPolicy=never` inside the sandbox; escalation
  requests are denied and logged.
- No telemetry; stdio only; no secrets stored.
