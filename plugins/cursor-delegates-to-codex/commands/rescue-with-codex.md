---
name: rescue-with-codex
description: After repeated failed implementation attempts, ask Codex to diagnose the common root cause and produce a rescue plan (read-only).
---

# Rescue with Codex

1. Collect the failed approaches (what was tried and how it failed) — not
   full logs or transcripts.
2. Call `codex_start` with mode `rescue`, permissionProfile `read-only`.
3. Present the root-cause analysis and rescue plan. Implementation happens
   only after the user approves, via `implement` mode in a worktree.
