---
name: plan-and-delegate-to-cursor
description: Use when the user asks Codex to plan and have Cursor execute, requests a structured handoff to Cursor, wants Cursor to implement a change while Codex supervises, or asks to monitor/continue/review/cancel a Cursor execution. Trigger phrases include "plan it and let Cursor do it", "hand off to Cursor", "check the Cursor job", "review what Cursor did". Do NOT use for tasks Codex should complete itself, quick edits, or questions.
---

# Plan and delegate to Cursor

You plan; Cursor executes. The bridge (MCP tools `cursor_start`,
`cursor_status`, `cursor_result`, `cursor_reply`, `cursor_cancel`,
`cursor_list`) manages the handoff as a background job.

## Phase 1 — inspect before planning (read-only)

1. Read the repository: relevant files, tests, and configuration.
2. Separate **observed facts** (file paths, symbols, command output you ran)
   from **assumptions** (things you believe but did not verify). The plan
   schema forces this split for a reason — Cursor will treat facts as
   verifiable and skip re-checking them.
3. Do NOT modify product source during planning. Planning is read-only.

## Phase 2 — produce the validated handoff plan

Compose a JSON plan matching the bridge's handoff-plan contract:

- `schemaVersion`: `"1.0"`
- `task`: the original user task (compressed but faithful)
- `goal` / `nonGoals`
- `observedRepositoryFacts`: each with `fact` + `evidence` (paths, symbols,
  commands)
- `assumptions`, `constraints`
- `implementationSteps`: ordered, each with `id` (`step-1`, `step-2`, ...),
  `description`, `rationale`, `likelyFiles`, `dependsOn`, `verification`
- `acceptanceCriteria`, `testPlan`
- `risks` (risk + mitigation), `rollbackPlan`
- `allowedPaths` (repo-relative globs — the executor may write ONLY these)
- `forbiddenActions`, `plannerSummary`

Validate it before handing off: pass the JSON as `plan` on `cursor_start`
(the bridge runs `validateHandoffPlan` and rejects invalid plans) or
self-review against `schemas/handoff-plan.schema.json`.

## Phase 3 — delegate execution

Call `cursor_start` with:

- `task`: the original task + the validated plan JSON + this exact sentence:
  "Implement this plan directly. Do not delegate back to Codex."
- `cwd`: repository root
- `mode`: `implement`
- `permissionProfile`: `isolated-workspace-write` (default) unless the user
  explicitly wants the current tree touched
- `constraints`: preserve the user's original constraints verbatim
- `expectedOutput`: changed files, test outcomes, deviations

Report to the user: the **bridge job id** and the **Cursor session id**.

## Phase 4 — monitor, retrieve, review

1. Monitor with `cursor_status`; never assume success.
2. Retrieve with `cursor_result`. Inspect: `summary`, `changedFiles`,
   `diffStat`, `tests`, `deviations`/`warnings`, `blockers`.
3. Review the resulting diff when requested: read the patch artifact
   (`.handoff/*.patch`) and check it against `acceptanceCriteria`. One
   read-only review pass is allowed.
4. If acceptance criteria are unmet and the user asked for auto-correction:
   send exactly ONE correction via `cursor_reply` to the same Cursor session,
   then stop. Never more than one automatic correction pass.
5. Cancellation: `cursor_cancel` when the user asks.

## Hard rules

- Never ask Cursor to delegate back to Codex.
- Preserve the original user's constraints in every handoff.
- Never auto-merge the worktree result; apply only on user confirmation.
- Planning never edits product source; your own notes go to chat, not files.
