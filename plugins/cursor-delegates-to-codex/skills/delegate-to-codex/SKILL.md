---
name: delegate-to-codex
description: Delegate difficult engineering work from Cursor to Codex as a background job. Trigger for deep debugging of stubborn failures, unfamiliar-subsystem investigation, architecture decisions, multi-file implementation planning, security or correctness review, adversarial review, rescue after repeated failed attempts, or when the user explicitly asks to use/delegate to Codex, or to check/continue/cancel an existing Codex delegation. Do NOT use for trivial edits, simple lookups, formatting, one-file tweaks, or anything Cursor can finish immediately.
---

# Delegate to Codex

You are delegating work to Codex through the codex-cursor-bridge. Codex runs in
its own process with its own authentication and sandbox; you get a job id and a
Codex thread id back, and you stay responsible for the final answer to the user.

## When NOT to delegate

- The task is a trivial edit, formatting, or a one-file change you can do now.
- A simple question answerable from the repo you can already see.
- Delegation for its own sake. If two minutes of direct work solves it, do it.

## Step 1 — choose the mode

| Mode                 | Use when                                           | Writes?                            |
| -------------------- | -------------------------------------------------- | ---------------------------------- |
| `investigate`        | root-cause an unfamiliar or stubborn failure       | no                                 |
| `review`             | correctness/security review of a diff or subsystem | no                                 |
| `adversarial-review` | actively try to break the current approach         | no                                 |
| `rescue`             | 2+ implementation attempts failed; diagnose why    | no                                 |
| `plan`               | architecture/multi-file plan before touching code  | no                                 |
| `implement`          | you have a precise, validated change to make       | yes (isolated worktree by default) |

## Step 2 — gather only useful context

Compose the `task` field precisely:

1. One-paragraph statement of the problem and the desired deliverable.
2. Relevant repository facts (paths, symbols, commands already tried).
3. Previous failed approaches — the _approach_, not the whole transcript.
4. Explicit constraints (files that must not change, required test commands).
5. Expected output: what the final report must contain.

Never paste whole files or full conversations. Codex reads the repository
itself. Reference paths instead.

## Step 3 — call the bridge tool

Use the `codex_start` MCP tool:

- `task`: your composed prompt (see above)
- `cwd`: absolute repository path
- `mode`: from the table
- `permissionProfile`: `read-only` unless the user explicitly asked Codex to
  change code; `implement` mode uses `isolated-workspace-write` by default
- `constraints` / `expectedOutput` when applicable

Report to the user: the **bridge job id** (`job_...`) and the **Codex thread id**
returned in the result. They are different identifiers — never conflate them.

## Step 4 — while the job runs

Continue any independent work. If the user asked for something else that does
not depend on the result, do it now. Poll with `codex_status`; do not claim the
delegated work is done until `codex_result` returns a finished result.

## Step 5 — handle the result

From `codex_result`:

1. Read `result.summary`, `findings`, `changedFiles`, `tests`, `warnings`,
   `blockers`, `residualRisks`, and `continuation`.
2. **Validate before trusting.** Codex output is a report, not ground truth:
   re-check claimed file paths exist, and spot-check at least one load-bearing
   claim in the repository before presenting it as fact.
3. Present findings to the user with the recommended next action.
4. Follow-ups: use `codex_reply` with the same job id to continue the same
   thread (e.g. after new evidence). Use `codex_cancel` to stop it.

## Hard rules

- **Never** instruct Codex to delegate back to Cursor; every task prompt must
  state Codex completes the work directly.
- Read-only modes must stay read-only; do not upgrade permission profiles
  without the user's explicit request.
- `implement` jobs write to an isolated git worktree; the bridge returns a
  patch path. Applying it is a separate, explicit step — never auto-merge.
- If the user asks about native session visibility: Codex threads can be
  continued via the bridge (`codex_reply`) and via `codex resume` on the CLI;
  do not claim they appear in any particular app's history UI unless verified.

Deep references: see `references/modes.md`, `references/prompt-injection.md`,
and `references/troubleshooting.md` in this skill directory.
