---
name: cancel-codex-job
description: Cancel a running Codex delegation; terminates the Codex process tree and records a cancelled result.
---

# Cancel Codex job

Call `codex_cancel` with `jobId`. Confirm to the user that the job was
cancelled and note the native thread id for any future `codex_reply`.
Cancelling never performs git operations; a worktree from an implement job is
left in place and can be removed later via the CLI.
