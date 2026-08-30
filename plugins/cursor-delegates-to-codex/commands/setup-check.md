---
name: setup-check
description: Diagnose the codex-cursor-bridge installation: bridge CLI, Codex CLI, authentication, adapters, git, and job state. Shows remediation steps without revealing secrets.
---

# Setup check

Run diagnostics:

```bash
codex-cursor-bridge doctor
```

Machine-readable:

```bash
codex-cursor-bridge doctor --json
```

The doctor checks (and never prints secret values):

- Node.js and git versions
- repository detection (dirty tree, missing initial commit warnings)
- Codex CLI presence/version, app-server initialize round-trip, login status
- Cursor SDK presence + `CURSOR_API_KEY` presence (value withheld)
- Cursor CLI (`cursor-agent`) presence/version, ACP startup probe
- which Cursor adapter would be selected (sdk → acp → cli-fallback)
- job-state directory writability, existing/stale jobs
- effective configuration (secrets redacted; none stored by design)

Fix each ✗ item using the `→` remediation line, then re-run doctor until only
✓ / · items remain. Exit code 0 means no blocking issues.
