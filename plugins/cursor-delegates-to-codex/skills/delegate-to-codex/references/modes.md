# Delegation modes in depth

## investigate (read-only)

Use when the failure resists normal debugging or the subsystem is unfamiliar.

Task template:

```
Investigate <problem>. Working directory: <abs path>.
Already tried: <approach 1> (failed because <reason>), <approach 2>.
Constraints: do not modify files; cite file paths and line evidence.
Expected output: root cause, supporting evidence, 2-3 candidate fixes with
risk assessment, and the exact commands you used.
```

## review (read-only)

Use for security/correctness review of a diff or a sensitive subsystem.

Task template:

```
Review <diff range or paths> for correctness, security, and maintainability.
Focus: <injection/auth/races/error-handling or specific concerns>.
Expected output: findings ranked by severity with file:line references, and an
explicit verdict: approve / approve-with-notes / changes-required.
```

## adversarial-review (read-only)

Use before risky releases or after a big refactor.

Task template:

```
Adversarially review <paths/approach>. Assume it is wrong; find how.
Hunt: edge cases, concurrency, resource leaks, injection, trust boundaries,
backwards compatibility, data loss paths.
Expected output: top 5 break attempts, each with reproduction reasoning and
likelihood; recommended mitigations.
```

## rescue

Use after 2+ failed implementation attempts. Send the *approaches*, not logs.

Task template:

```
Rescue situation. Goal: <original goal>.
Attempt 1: <approach> — failed: <observed failure>.
Attempt 2: <approach> — failed: <observed failure>.
Diagnose the common root cause, then state the least-risky path forward.
Expected output: root-cause analysis + concrete rescue plan.
```

## plan (read-only)

Produces a structured plan; the bridge validates plans before any execution.

Task template:

```
Produce an implementation plan for <goal>. Do not modify files.
Include: observed repository facts with evidence paths, assumptions vs facts,
ordered steps with verification commands per step, risks with mitigations,
rollback plan, allowed paths, and acceptance criteria.
```

## implement (writes; isolated worktree by default)

Only with a precise validated change. The bridge runs Codex with
workspace-write inside a temporary git worktree created from a recorded base
ref, collects the diff, and returns a patch path.

Task template:

```
Implement: <precise change description>.
Constraints: <files in scope>, <style/test requirements>.
Run <test command> and report its exact outcome.
Expected output: list of files changed, test results, deviations (if any).
```

Result handling: the result contains `diffStat`, `changedFiles`, and
`diffPatchPath` (a `.patch` file under `.handoff/`). Present the patch to the
user and apply it only on their confirmation:

```
git apply <path>
```

Never merge, cherry-pick, or push automatically.
