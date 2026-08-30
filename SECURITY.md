# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | yes       |

## Reporting a vulnerability

This project executes coding agents against real source repositories, so we
treat security reports with high priority.

Please do **not** open a public GitHub issue for security problems.

1. Use GitHub's private vulnerability reporting on this repository
   (Security → Report a vulnerability), or
2. Open a minimal, non-public advisory draft if you prefer coordination via
   GitHub Security Advisories.

Include: affected version/commit, a minimal reproduction, impact assessment,
and any logs with secrets already redacted.

We aim to acknowledge reports within 5 business days and to publish fixes and
an advisory for confirmed vulnerabilities.

## Security model summary

The full threat model lives in [docs/security-model.md](docs/security-model.md).
Key invariants:

- No listening network ports; stdio-only transports by default.
- No telemetry, analytics, or outbound calls beyond the configured agent CLIs.
- Job state is stored with restrictive permissions under the OS user state
  directory; API keys are never persisted by this project.
- Child agents are spawned with argument arrays (never a shell), sandboxed to
  read-only by default, and write access requires an explicit profile.
- Destructive git operations are never performed automatically.
- Recursion between hosts is capped (handoff depth 1 by default, hard max 2).

## Scope

In scope: this repository's code, packaging, CI, and default configurations.
Out of scope: vulnerabilities in Codex, Cursor, their CLIs/SDKs, or GitHub —
please report those to the respective vendors.
