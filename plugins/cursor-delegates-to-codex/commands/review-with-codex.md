---
name: review-with-codex
description: Send a correctness/security review of the current diff or selected files to Codex (read-only) and summarize the verdict.
---

# Review with Codex

1. Determine the review scope: the current branch's diff
   (`git diff <base>...`), staged changes, or user-specified paths.
2. Call `codex_start` with mode `review`, permissionProfile `read-only`,
   constraints naming the scope, and expectedOutput of a ranked findings list
   plus an explicit verdict.
3. Report findings with file:line references and the verdict. Validate a
   sample of references against the repository before presenting.
