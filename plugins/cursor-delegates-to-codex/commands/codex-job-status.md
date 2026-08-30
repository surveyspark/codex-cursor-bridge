---
name: codex-job-status
description: Check the status of a running or finished Codex delegation job (bridge job id or list recent jobs).
---

# Codex job status

With a job id: call `codex_status` with `jobId` and report state, adapter,
native thread id, and recent events.

Without a job id: call `codex_list` and present the recent jobs table.
