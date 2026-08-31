# codex-cursor-bridge — Codex plugin

Plan in Codex, execute in Cursor.

This plugin packages:

- **Skill** `plan-and-delegate-to-cursor` — repository inspection, validated
  handoff plans, delegation to Cursor, monitoring, diff review, one-shot
  correction, cancellation.
- References: plan field guide, diff review procedure, adapter troubleshooting.

## Prerequisites

- Node.js >= 20.19
- One Cursor transport: `@cursor/sdk` + `CURSOR_API_KEY`, or the Cursor CLI
  (official CLI via `curl https://cursor.com/install -fsS | bash`; binary
  `agent`, logged in via `agent login` — no npm package exists)
- The bridge CLI on PATH (`codex-cursor-bridge`)

## Install (release archive)

1. Unzip `codex-cursor-bridge-cli-<ver>.zip`; run `install.sh` / `install.ps1`
   to place the CLI.
2. Copy this plugin directory to `~/.codex/plugins/codex-cursor-bridge`
   (install.sh does this automatically).
3. Verify: `codex-cursor-bridge doctor`.

## Usage in Codex

Ask for: "Plan X and delegate execution to Cursor", then monitor with the
`cursor_*` tools the bridge MCP server exposes
(`codex-cursor-bridge mcp --host codex`).

## Security posture

- Planning is read-only; the plan cannot edit product source.
- Execution happens in Cursor under a permission profile; default writes go
  to an isolated git worktree and return a patch.
- Recursion is capped: Cursor cannot hand the work back to Codex.
