# Contributing to codex-cursor-bridge

Thanks for your interest in contributing! This document explains how to set up,
develop, test, and submit changes.

## Project independence

This is an independent, community-built interoperability project. It is not
affiliated with, sponsored by, or endorsed by OpenAI or Cursor (Anysphere).
Please keep product names limited to descriptive interoperability use and do
not add vendor logos or imply endorsement.

## Development setup

Requirements: Node.js >= 20.19, npm >= 10, git, and at least one of the Codex
CLI or Cursor CLI for integration testing.

```bash
git clone https://github.com/surveyspark/codex-cursor-bridge.git
cd codex-cursor-bridge
npm ci
npm run build
npm test
```

## Repository layout

- `packages/` — TypeScript workspace packages (bridge-core, adapters, job
  store, MCP server, CLI, test support).
- `plugins/` — host-specific plugin manifests and Agent Skills.
- `schemas/` — JSON Schemas for handoff plans, job records, and results.
- `docs/` — architecture, compatibility research, protocol, security model.
- `tests/` — integration, contract, security, and e2e test suites.
- `scripts/` — build, packaging, and validation scripts.

## Ground rules

- TypeScript strict mode; no `any` in exported APIs.
- No placeholder implementations or TODO-only functions.
- Every protocol behavior change needs a test.
- Security-sensitive changes require tests in `tests/security/` and an update
  to `docs/security-model.md`.
- Keep production dependencies minimal; prefer Node.js built-ins.
- No secrets, tokens, or personal paths in commits, fixtures, or logs.
- Run `npm run format:check`, `npm run lint`, `npm run typecheck`, and
  `npm test` before opening a pull request.

## Commit style

Use Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`,
`ci:`). Keep commits logically scoped.

## Pull requests

Fill in the PR template, link related issues, and ensure CI is green. For
larger changes, open an issue first to discuss the approach.

## Reporting vulnerabilities

Do not open public issues for security problems. Follow
[SECURITY.md](SECURITY.md) for responsible disclosure.
