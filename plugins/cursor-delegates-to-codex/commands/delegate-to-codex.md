---
name: delegate-to-codex
description: Delegate the current problem to Codex as a background job (investigate / review / adversarial-review / rescue / plan / implement) and report the job id and Codex thread id.
---

# Delegate to Codex

Delegate the user's current problem following the `delegate-to-codex` skill.

1. Pick the mode from the user's intent (default: `investigate` for debugging
   questions, `review` for "check my diff", `implement` only when they asked
   Codex to change code).
2. Compose the task per the skill's Step 2 and call `codex_start`.
3. Report the bridge job id and Codex thread id, then continue independent
   work and retrieve the result with `codex_result` before concluding.
