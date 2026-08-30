---
name: implement-with-codex
description: Delegate an implementation to Codex in an isolated git worktree; receive a patch artifact and diff summary without touching the current tree.
---

# Implement with Codex (isolated worktree)

Requires an explicit user request to have Codex change code.

1. Write down the precise change, in-scope files, and test commands.
2. Call `codex_start` with mode `implement` and permissionProfile
   `isolated-workspace-write` (default; current-tree writes only when the
   user explicitly insists).
3. From the result, report `changedFiles`, `diffStat`, and `diffPatchPath`.
4. Apply the patch (`git apply <patchPath>`) only on explicit user
   confirmation. Never merge/push automatically.
