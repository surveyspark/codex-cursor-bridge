# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-09-01

### Fixed

- Cursor CLI resolution now prefers the official `agent` binary
  (cursor.com/install); the npm `cursor-agent` package is third-party and is
  only accepted as a legacy alias. Docs, doctor remediations, and plugin
  READMEs corrected.
- ACP permission denial now matches the documented option kinds
  (`reject_once`/`reject_always`) per the Agent Client Protocol spec.

### Documented

- Full Cursor integration research notes (skills directories and frontmatter
  fields incl. `paths`/`disable-model-invocation`, hooks events and matchers,
  MCP config interpolation and deeplinks, CLI parameter reference, `@cursor/sdk`
  API surface and REST endpoints, ACP protocol v1 details) filed from official
  sources; recorded in docs/compatibility.md.

## [0.1.0] - 2026-08-31

### Added

- Initial public release.
- `codex-cursor-bridge` CLI: doctor, host-scoped MCP servers, job commands (start/status/result/reply/cancel), jobs clean/recover, config show, demos.
- Codex adapter: `codex app-server` (initialize / thread-start / turn-start / interrupt / resume, auto-deny approvals, sandbox per profile) with one-shot `codex exec --json` fallback.
- Cursor adapters: `@cursor/sdk`, `cursor-agent acp` (permission requests denied, session ids preserved), gated `--print` fallback.
- Persistent background jobs: atomic records, dir-locking, crash recovery, retention, concurrency, timeouts, process-tree cancellation.
- Handoff-plan / job-record / result JSON Schemas with runtime validation.
- Git worktree isolation with patch export to `.handoff/`; read-only enforcement with accidental-modification detection.
- Recursion prevention (depth cap 1, hard max 2) and opposite-host tool scoping.
- Secret redaction across logs, events, and job records.
- `delegate-to-codex` Agent Skill + Cursor plugin (10 commands); `plan-and-delegate-to-cursor` Agent Skill + Codex plugin.
- 66 automated tests (unit/protocol/contract/integration/security) plus 5 reproducible demos against fake agents.
- CI (3 OSes × Node 20/22), CodeQL, gitleaks, dependency review; release pipeline with checksums + SBOM.

### Added

- Initial public release: `codex-cursor-bridge` CLI, MCP servers
  (`--host cursor` exposes Codex tools; `--host codex` exposes Cursor tools),
  background job system with start/status/result/reply/cancel/list/clean,
  Codex app-server and `codex exec` fallback adapters, Cursor SDK and
  Cursor ACP adapters with non-interactive CLI fallback,
  handoff-plan / job-record / result JSON Schemas, Git worktree isolation,
  permission profiles (read-only, isolated-workspace-write,
  current-workspace-write), recursion prevention, secret redaction,
  doctor diagnostics, demo suite, tests, CI, and release pipeline.
- `delegate-to-codex` Agent Skill and Cursor plugin.
- `plan-and-delegate-to-cursor` Agent Skill and Codex plugin.
