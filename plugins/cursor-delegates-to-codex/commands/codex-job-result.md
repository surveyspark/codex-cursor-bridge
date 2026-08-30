---
name: codex-job-result
description: Retrieve the full result of a finished Codex delegation (summary, findings, changed files, tests, risks, continuation info).
---

# Codex job result

Call `codex_result` with `jobId`. Present:

- summary and findings
- changed files + diff stats (implement jobs) and the patch path
- tests actually executed and their outcomes
- blockers and residual risks verbatim

Validate load-bearing claims against the repository before acting on them.
If the job has no result yet, report the current status instead of guessing.
