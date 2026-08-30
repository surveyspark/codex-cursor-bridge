---
name: adversarial-review-with-codex
description: Launch an adversarial Codex review that actively tries to break the current approach before a risky change or release.
---

# Adversarial review with Codex

1. Identify the approach/diff to attack.
2. Call `codex_start` with mode `adversarial-review`, permissionProfile
   `read-only`, and an expectedOutput of top break attempts with likelihood
   and mitigations.
3. Present the attack surface honestly, including residual risks. Do not
   soften findings.
