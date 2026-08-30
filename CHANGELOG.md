# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
