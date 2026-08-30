---
name: reply-to-codex
description: Send a follow-up message to the same Codex thread of an existing delegation job (continuation with full prior context).
---

# Reply to Codex

Call `codex_reply` with the original `jobId` and the follow-up message. The
same Codex thread continues with its prior context. Report the job id used.
If the bridge reports no native session id, explain that the thread cannot be
continued and offer a fresh delegation with context included.
