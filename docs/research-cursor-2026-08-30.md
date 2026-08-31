# CURSOR INTEGRATION RESEARCH REPORT (researched 2026-08-30)

Scope: official sources only — cursor.com/docs (docs.cursor.com redirects there), npm registry, GitHub `cursor/*` org, agentclientprotocol.com, and one Wayback snapshot of official docs where the live page was removed. Every fact carries its source URL. Where official docs are silent, this report says so explicitly.

---

## 1. Cursor Agent Skills

**Official docs page:** https://cursor.com/docs/skills (legacy URL https://cursor.com/help/customization/skills and FAQ page https://cursor.com/docs/agent/commands now both surface skills content)

- "Agent Skills is an open standard for extending AI agents with specialized capabilities." The page links out to **https://agentskills.io** as the standard: "Agent Skills is an open standard. Learn more at agentskills.io." (https://cursor.com/docs/skills). There is no separate Cursor-owned skills spec repo under github.com/cursor (verified via GitHub org listing: https://api.github.com/orgs/cursor/repos — repos are cursor/cursor, cursor/plugins, cursor/community-plugins, cursor/cookbook, cursor/sdk-bridge, cursor/mcp-servers, cursor/plugin-template, cursor/minisqlite, etc.).
- A skill = a folder containing `SKILL.md` (plus optional `scripts/`, `references/`, `assets/` directories). Structure:
  ```
  .agents/skills/my-skill/SKILL.md
  .agents/skills/deploy-app/{SKILL.md, scripts/deploy.sh, scripts/validate.py, references/REFERENCE.md, assets/config-template.json}
  ```
- **Skill directories** (loaded automatically, from https://cursor.com/docs/skills):
  | Location | Scope |
  |---|---|
  | `.agents/skills/` | Project-level |
  | `.cursor/skills/` | Project-level |
  | `~/.agents/skills/` | User-level (global) on the local machine |
  | `~/.cursor/skills/` | User-level (global) on the local machine |
  - Compatibility: Cursor also loads `.claude/skills/`, `.codex/skills/`, `~/.claude/skills/`, `~/.codex/skills/`.
  - Nested/category folders are supported (`.cursor/skills/shipping/land-it/SKILL.md`); the skill's identity comes from the folder containing SKILL.md. Monorepos: any nested `.cursor/skills/` or `.agents/skills/` inside the repo is discovered and auto-scoped to that directory's files.
  - User-level skill folders are **not** copied to Cloud Agents / remote SSH / BYO workers — use project skills or bake into the worker image.
- **SKILL.md frontmatter fields** (from https://cursor.com/docs/skills):
  | Field | Required | Rules |
  |---|---|---|
  | `name` | Yes | "Lowercase letters, numbers, and hyphens only. **Must match the parent folder name.**" |
  | `description` | Yes | "Describes what the skill does and when to use it. Used by the agent to determine relevance." |
  | `paths` | No | Glob patterns scoping the skill to matching files; accepts a list **or** a single comma-separated string (e.g. `paths: "**/*.py, scripts/**/*.py"`). Legacy `globs` field "still accepted as a fallback for older skills, but new skills should use paths." |
  | `disable-model-invocation` | No | `true` → only included when explicitly invoked via `/skill-name`; agent will not auto-apply. |
  | `icon` | No | Badge icon when used as a Custom Mode (names like `code`, `terminal`, `bug`, `git-branch`, `beaker`, `rocket`). Unrecognized → default lightning icon. |
  | `color` | No | One of `default, green, cyan, blue, purple, magenta, orange, yellow, red, brand`. |
  | `metadata` | No | "Arbitrary key-value mapping for additional metadata." |
- **Versioning:** no version field is documented for SKILL.md frontmatter. Skills are "portable, version-controlled packages" — i.e. version them by committing to git; installing from GitHub repos is done via **Customize → Rules → Add Rule → Remote Rule (Github)** with a GitHub repo URL (https://cursor.com/docs/skills). No semantic versioning field exists in official docs.
- **Invocation:** type `/` in Agent chat and search the skill name (attaches to one message); `@` to attach as context (https://cursor.com/docs/agent/commands FAQ); or keep it on for the whole session as a **Custom Mode** (Option+Enter / Alt+Enter). Built-in skills include `/create-skill`, `/migrate-to-skills` (converts eligible dynamic rules and slash commands; available in Cursor 2.4+), `/create-rule`, `/create-hook`, `/review`, `/loop`, `/sdk`, `/shell`, etc. (full table at https://cursor.com/docs/skills).

## 2. Cursor Commands (slash commands)

**Status:** the dedicated docs page `cursor.com/docs/agent/chat/commands` was removed/redirected to the Skills FAQ (live fetch of https://cursor.com/docs/agent/chat/commands returns the Skills FAQ content). The file format below is from the official docs via Wayback snapshot (http://web.archive.org/web/20250825043253/https://docs.cursor.com/en/agent/chat/commands, "Commands — Define commands for reusable workflows", marked _beta_):

- Commands are **plain Markdown files** in `.cursor/commands/` in the project root. The **filename is the command name** (`review-code.md` → `/review-code`).
- Created by: 1) create `.cursor/commands/` directory; 2) add `.md` files with descriptive names; 3) write plain Markdown describing the workflow. Commands automatically appear when typing `/` in chat.
- Example layout from the archived official page:
  ```
  .cursor/commands/
  ├── address-github-pr-comments.md
  ├── code-review-checklist.md
  ├── create-pr.md
  ├── security-audit.md
  └── setup-new-feature.md
  ```
- **Frontmatter schema:** none documented. The archived official page shows plain-Markdown files with no frontmatter. (A forum feature request asks to allow a `model` property in command frontmatter — https://forum.cursor.com/t/commands-should-allow-model-selection-allow-model-property-in-command-frontmatter/151140 — i.e. not currently documented/supported.)
- **User-level commands:** the current live Skills page (https://cursor.com/help/customization/skills) says `/migrate-to-skills` converts "Slash commands: **Both user-level and workspace-level commands**, preserving their explicit invocation behavior." So user-level commands exist, but the **user-level directory path (e.g. `~/.cursor/commands/`) is not stated anywhere in current official docs** — not found; do not assume.
- **Current direction:** commands are being migrated into Agent Skills via the built-in `/migrate-to-skills` skill (Cursor 2.4+): "Dynamic rules … Slash commands: Both user-level and workspace-level commands, preserving their explicit invocation behavior" (https://cursor.com/docs/agent/commands). For new work, the official docs steer you to skills with `disable-model-invocation: true` to emulate slash-command behavior.

## 3. Cursor Hooks

**Official docs page:** https://cursor.com/docs/hooks

- **Config file locations** (all matching sources run; merge priority **Enterprise → Team → Project → User**):
  - Project: `<project-root>/.cursor/hooks.json` (runs from project root; requires trusted workspace; checked into VCS)
  - User: `~/.cursor/hooks.json` (scripts run from `~/.cursor/`)
  - Enterprise (MDM, system-wide): macOS `/Library/Application Support/Cursor/hooks.json`, Linux/WSL `/etc/cursor/hooks.json`, Windows `C:\ProgramData\Cursor\hooks.json`
  - Team (Enterprise): cloud-distributed from web dashboard
- **JSON schema:** `{ "version": 1, "hooks": { "<eventName>": [ { "command": "...", "type": "command"|"prompt", "timeout": <sec>, "loop_limit": <n|null>, "failClosed": <bool>, "matcher": "<pattern>" } ] } }`
  - Global option: `version` (number, default 1). Per-script options: `command` (required), `type` (`"command"` default | `"prompt"`), `timeout` (seconds), `loop_limit` (stop/subagentStop auto-follow-up cap; default 5, `null` = unlimited), `failClosed` (default `false`; `true` blocks the action when the hook crashes/times-outs/returns invalid JSON), `matcher` (filter criteria; a string matched against a hook-specific field).
  - **Prompt hooks:** `{ "type": "prompt", "prompt": "<natural-language condition>", "timeout": 10 }` — LLM-evaluated, returns `{ ok: boolean, reason?: string }`; `$ARGUMENTS` placeholder auto-replaced with hook input JSON; optional `model` field.
  - **Exit codes (command hooks):** `0` = success (use JSON output), `2` = block (equivalent to `permission: "deny"`), anything else = hook failed, action proceeds (**fail-open** unless `failClosed: true`).
- **Event types** (all documented on https://cursor.com/docs/hooks):
  - Agent hooks: `sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `subagentStart`, `subagentStop`, `beforeShellExecution`, `afterShellExecution`, `beforeMCPExecution`, `afterMCPExecution`, `beforeReadFile`, `afterFileEdit`, `beforeSubmitPrompt`, `preCompact`, `stop`, `afterAgentResponse`, `afterAgentThought`
  - Tab hooks: `beforeTabFileRead`, `afterTabFileEdit`
  - App lifecycle: `workspaceOpen` (fires on workspace open and folder changes; can return `pluginPaths`)
- **Matcher syntax** (string, regex-style alternation, matched per hook):
  - `preToolUse`/`postToolUse`/`postToolUseFailure`: tool type — values include `Shell`, `Read`, `Write`, `Grep`, `Delete`, `Task`, and MCP tools as `MCP:<tool_name>` (example uses `"Shell|Read|Write"`)
  - `subagentStart`/`subagentStop`: subagent type (e.g. `generalPurpose`, `explore`, `shell`; example `"explore|shell"`)
  - `beforeShellExecution`/`afterShellExecution`: matched against the **full shell command string** (e.g. `"curl|wget|nc"`)
  - `beforeReadFile`: tool type (`TabRead`, `Read`, …); `afterFileEdit`: tool type (`TabWrite`, `Write`, …)
  - `beforeSubmitPrompt` → matches `UserPromptSubmit`; `stop` → `Stop`; `afterAgentResponse` → `AgentResponse`; `afterAgentThought` → `AgentThought`
- **Hook I/O:** hooks are spawned processes; JSON in via stdin, JSON out via stdout. Common input fields for all hooks: `conversation_id`, `generation_id`, `model`, `model_id`, `model_params[]`, `hook_event_name`, `cursor_version`, `workspace_roots[]`, `user_email`, `transcript_path`. Each event has a documented input/output shape, e.g.:
  - `preToolUse` input `{tool_name, tool_input, tool_use_id, cwd, model…, agent_message}` → output `{permission: "allow"|"deny", user_message?, agent_message?, updated_input?}` (note: `"ask"` is accepted by schema but **not enforced** for preToolUse today).
  - `beforeShellExecution` input `{command, cwd, sandbox}` → output `{permission: "allow"|"deny"|"ask", …}`; `beforeMCPExecution` input includes `tool_name`, `tool_input`, `mcp_server_name`, plus `url` (HTTP/SSE) or `command` (stdio).
  - `stop` input `{status: "completed"|"aborted"|"error", loop_count}` → output `{followup_message}` auto-submits a follow-up (loop-limited via `loop_limit`).
  - `sessionStart` output `{env: {...}, additional_context}`.
- **Environment variables** given to hook scripts: `CURSOR_PROJECT_DIR`, `CURSOR_VERSION`, `CURSOR_USER_EMAIL` (if logged in), `CURSOR_TRANSCRIPT_PATH` (if enabled), `CURSOR_CODE_REMOTE` (remote workspaces), `CLAUDE_PROJECT_DIR` (Claude-compat alias).
- **Cloud agent support:** cloud agents run command-based hooks from repo `.cursor/hooks.json` (subset: before/afterShellExecution, beforeReadFile, afterFileEdit, pre/postToolUse, postToolUseFailure, subagentStart/Stop, beforeSubmitPrompt, preCompact, afterAgentResponse/Thought, stop; NOT sessionStart/sessionEnd/MCP hooks/Tab hooks/workspaceOpen). User-level hooks unavailable in cloud.
- **CLI caveat:** official docs do not enumerate which hooks fire in Cursor CLI. The official forum reports "Cursor CLI only supports the beforeShellExecution and afterShellExecution hooks; the config is the same as in the IDE" (https://forum.cursor.com/t/cursor-cli-doesnt-send-all-events-defined-in-hooks/148316). Treat CLI hook coverage as limited and unverified by docs.

## 4. Cursor Rules

**Official docs page:** https://cursor.com/docs/rules

- **Location/format:** Project Rules live in `.cursor/rules/` as **`.mdc` files** ("Project rules must use the .mdc extension. A plain .md file in .cursor/rules is ignored by the rules system"). Folders inside `.cursor/rules/` are allowed for organization.
- **Frontmatter fields:** `description` (string), `globs` (comma-separated glob patterns), `alwaysApply` (boolean). Behavior matrix (verbatim from docs):
  | `alwaysApply` | `description` | `globs` | Behavior |
  |---|---|---|---|
  | `true` | — | — | Always included; globs and description ignored |
  | `false` | — | provided | Auto-attached when a matching file is in context |
  | `false` | provided | omitted | Agent reads the description and pulls the rule in when relevant ("Apply Intelligently") |
  | `false` | omitted | omitted | Included only when @-mentioned in chat ("Apply Manually") |
- **Rule types UI mapping:** Always Apply / Apply Intelligently / Apply to Specific Files / Apply Manually (@-mention, e.g. `@my-rule`).
- **Glob examples:** `*`, `**`, `*.ts`, `**/*.ts`, `src/**`, `src/**/*.tsx`, `docs/**/*.md, docs/**/*.mdx` (comma-separated), `tailwind.config.*`.
- Other rule surfaces: **User Rules** (global, set in Cursor settings — not filesystem-based), **Team Rules** (dashboard, Team/Enterprise plans), and **AGENTS.md** ("Agent instructions in markdown format. Simple alternative to .cursor/rules").
- Creation: `/create-rule` in chat, or Customize → Rules → Add Rule. Best practice: keep rules under 500 lines.

## 5. Cursor MCP integration

**Official docs pages:** https://cursor.com/docs/mcp and https://cursor.com/docs/mcp/install-links

- **Config files:** project `.cursor/mcp.json`, global `~/.cursor/mcp.json`. Top-level shape: `{ "mcpServers": { "<server-name>": { ... } } }`.
- **Transports supported:** `stdio` (local, single user, shell command, manual auth), `SSE`, and `Streamable HTTP` (local/remote, URL endpoint, OAuth). Protocol capabilities supported: Tools, Prompts, Resources, Roots, Elicitation, and the **MCP Apps** extension (interactive UI views).
- **stdio server config fields** (docs table): `type` ("stdio", required), `command` (required), `args` (array, optional), `env` (object, optional), `envFile` (path to .env, optional; stdio only — remote servers don't support envFile).
- **Remote server fields:** `url` (HTTP/SSE endpoint), `headers` (e.g. `{"API_KEY": "..."}`), optional `auth` for static OAuth: `{ "CLIENT_ID": "...", "CLIENT_SECRET": "...", "scopes": ["read","write"] }` (scopes optional; discovered via `/.well-known/oauth-authorization-server` if omitted).
- **Config interpolation** in `command`, `args`, `env`, `url`, `headers`: `${env:NAME}`, `${userHome}`, `${workspaceFolder}`, `${workspaceFolderBasename}`, `${pathSeparator}` / `${/}`.
- **OAuth redirect URLs (fixed):** web + agents: `https://www.cursor.com/agents/mcp/oauth/callback`; desktop: `http://localhost:8787/callback`.
- **Install deeplink** (https://cursor.com/docs/mcp/install-links):

  ```
  cursor://anysphere.cursor-deeplink/mcp/install?name=$NAME&config=$BASE64_ENCODED_CONFIG
  ```

  - `name` = server name query param; `config` = base64 of `JSON.stringify(config)`. Config uses the **same format as mcp.json** ("It uses the same format as mcp.json with a name and transport configuration"), e.g. `{"postgres":{"command":"npx","args":["-y","@modelcontextprotocol/server-postgres","postgresql://localhost/mydb"]}}`.
  - Component table: scheme `cursor://`, handler `anysphere.cursor-deeplink`, path `/mcp/install`, params `name`, `config`.

- **Programmatic registration:** VS Code extension API `vscode.cursor.mcp.registerServer()` (https://cursor.com/docs/mcp → "Extension API reference").
- **CLI MCP management:** `agent mcp login <identifier>`, `agent mcp list`, `agent mcp list-tools <identifier>`, `agent mcp enable <identifier>`, `agent mcp disable <identifier>` (https://cursor.com/docs/cli/reference/parameters).
- **ACP-mode MCP caveat:** "ACP supports MCP servers defined in a project-level or user-level .cursor/mcp.json. … Team-level MCP servers configured through the Cursor dashboard are **not** supported in ACP mode." (https://cursor.com/docs/cli/acp)

## 6. Cursor CLI (`agent`)

**Official pages:** overview https://cursor.com/docs/cli/overview, installation https://cursor.com/docs/cli/installation, parameters https://cursor.com/docs/cli/reference/parameters, auth https://cursor.com/docs/cli/reference/authentication, output format https://cursor.com/docs/cli/reference/output-format, headless https://cursor.com/docs/cli/headless, ACP https://cursor.com/docs/cli/acp, changelog https://cursor.com/docs/cli/changelog

- **⚠️ The npm package `cursor-agent` is NOT official.** Registry data: `cursor-agent@1.0.3`, description "Task sequence creator for Cursor AI agents", repository `github.com/zalab-inc/cursor_agent`, last published 2025-01-10 (https://registry.npmjs.org/cursor-agent). Do not use it. There is **no official npm package** for the Cursor CLI; it is distributed via the installer script only.
- **Install command (official):**
  ```bash
  curl https://cursor.com/install -fsS | bash            # macOS, Linux, WSL
  irm 'https://cursor.com/install?win32=true' | iex      # Windows (PowerShell)
  ```
  Binary is `agent`; verify with `agent --version`; update with `agent update`; auto-update by default. Installer as researched pins build `2026.08.25-3e8eec8` (`https://downloads.cursor.com/lab/2026.08.25-3e8eec8/${OS}/${ARCH}/agent-cli-package.tar.gz` — read from https://cursor.com/install script). CLI changelog's newest entry: August 11, 2026 (https://cursor.com/docs/cli/changelog).
- **Non-interactive / print mode flags** (verbatim from https://cursor.com/docs/cli/reference/parameters):
  - `-p, --print` — "Print responses to console (for scripts or non-interactive use). Has access to all tools, including write and shell."
  - `--output-format <format>` — `text` (default) | `json` | `stream-json`; "only works with --print"
  - `--stream-partial-output` — "only works with --print and stream-json format" (character-level deltas)
  - `--resume [chatId]` — resume a chat session; `--continue` — "alias for --resume=-1" (previous session); `agent ls`, `agent resume`, `agent create-chat`
  - `--model <model>`, `--list-models`; `--mode <plan|ask>` (agent default), `--plan` shorthand
  - Permissions: `-f, --force` ("Force allow commands unless explicitly denied"), `--yolo` (alias), `--sandbox <enabled|disabled>`, `--approve-mcps`, `--trust` (headless only; trust workspace without prompting), `--workspace <path>`, `--plugin-dir <path>` (repeatable)
  - Worktrees: `-w, --worktree [name]` ("Run in a new Git worktree under `~/.cursor/worktrees/<reponame>/<name>`; if omitted, a name is generated"), `--worktree-base <branch>` (default current HEAD), `--skip-worktree-setup`
  - Global: `-v, --version`, `--api-key ***` (or `CURSOR_API_KEY` env), `-H, --header <header>` (repeatable)
  - Headless nuance (https://cursor.com/docs/cli/headless): "Combine --print with --force (or --yolo) to modify files in scripts … Without --force, changes are only proposed, not applied."
- **Subcommands:** `agent [prompt...]`, `login`, `logout`, `status` (alias `whoami`; `--format text|json`), `about` (`--format text|json`), `models`, `mcp` (above), `sandbox` (`enable|disable|reset|run` with `--allow-paths`, `--readonly-paths`, `--blocked-patterns`, `--sandbox`, `--network`, `--sb-debug`), `worker start` (private cloud worker; `--auth-token-file`, `--worker-dir`, `--pool`, `--pool-name`, `--label`, `--labels-file`, `--idle-release-timeout`, `--data-dir`, …), **`acp`** ("Start ACP server mode (advanced, **hidden command**)" — `agent acp`), `update`, `ls`, `resume`, `create-chat`, `generate-rule` (alias `rule`), `install-shell-integration`, `uninstall-shell-integration`, `help`.
- **Auth:** `agent login` (browser flow; `NO_OPEN_BROWSER=1` prints URL), `agent logout`, `agent status`. API keys: `export CURSOR_API_KEY=...` (recommended) or `agent --api-key ***`. Keys come from Cursor Dashboard → API Keys. Also `CURSOR_AUTH_TOKEN` / `--auth-token`, endpoint override `agent -e https://api2.cursor.sh acp`, `-k` (insecure-TLS flag shown on the ACP page) (https://cursor.com/docs/cli/reference/authentication, https://cursor.com/docs/cli/acp).
- **Session ids:** every run emits a `session_id` (UUID) in output events; chat/session resume uses chat IDs (`--resume <chatId>`, `agent ls`, `agent resume`, `/copy-conversation-id`).
- **Interactive slash commands** (https://cursor.com/docs/cli/reference/slash-commands): `/model [filter]`, `/plan [prompt]`, `/ask`, `/debug`, `/goal [objective]` ("Rolling out"), `/resume`, `/fork`, `/summarize` (`/compress`), `/rewind`, `/clear` (`/new`), `/shell [command]` (`/sh`, `/run`), `/mcp [list|list-tools]`, `/sandbox`, `/config`, `/plugin`, `/run-everything [on|off|status]` (`/auto-run` alias), `/about`, `/logout`, `/quit` etc.

## 7. Official Cursor TypeScript SDK

- **Package:** `@cursor/sdk` — "TypeScript SDK for Cursor agents." **Latest 1.0.30, published 2026-08-27**, 26 versions, `engines: node >=22.13`, repository `github.com/cursor/cursor`, homepage cursor.com (https://registry.npmjs.org/@cursor%2Fsdk). Docs: https://cursor.com/docs/sdk/typescript; blog: https://cursor.com/blog/typescript-sdk; install `npm install @cursor/sdk` ("The bare cursor/sdk doesn't exist on npm"). Per-platform binaries ship as `@cursor/sdk-<os>-<arch>`. Entries: `@cursor/sdk`, `@cursor/sdk/bundled` (single-file build for bun build --compile/esbuild), `@cursor/sdk/bundled/sqlite` / `@cursor/sdk/sqlite` (SqliteLocalAgentStore). Python SDK docs exist at https://cursor.com/docs/sdk/python and a language-agnostic "SDK Bridge" at https://cursor.com/docs/sdk/bridge.
- **Auth:** `CURSOR_API_KEY` env var or `apiKey` option. "The SDK accepts user API keys and service account API keys for both local and cloud runs. Team Admin API keys are not yet supported." `Cursor.auth.login()` opens browser login and mints a user API key (90 days default) stored in `~/.cursor/sdk/auth.json`; `Cursor.auth.status()`, `Cursor.auth.logout()`. Credential resolution: explicit `apiKey` → `CURSOR_API_KEY` → stored login (https://cursor.com/docs/sdk/typescript).
- **Core model:** `Agent` (durable container: conversation state, workspace config) + `Run` (one prompt) + `SDKMessage` (normalized stream events, same shape across runtimes). Runtime picked by `local` vs `cloud` option.
- **Key API methods (signatures from https://cursor.com/docs/sdk/typescript):**

  ```ts
  function Agent.create(options: AgentOptions): Promise<SDKAgent>;
  function Agent.resume(agentId: string, options?: Partial<AgentOptions>): Promise<SDKAgent>;
  function Agent.prompt(message: string, options?: AgentOptions): Promise<RunResult>;  // one-shot

  interface SDKAgent {
    readonly agentId: string;                    // local: "agent-<uuid>", cloud: "bc-<uuid>"
    readonly model: ModelSelection | undefined;
    send(message: string | SDKUserMessage, options?: SendOptions): Promise<Run>;
    close(): void; reload(): Promise<void>; [Symbol.asyncDispose](): Promise<void>;
    listArtifacts(): Promise<SDKArtifact[]>;
    downloadArtifact(path: string): Promise<Buffer>;
    getUsage(options?: GetUsageOptions): Promise<AgentUsage>;
  }
  // Run: run.stream(): AsyncIterable<SDKMessage>; run.wait(): Promise<RunResult>;
  //      run.cancel(); run.conversation(): Promise<ConversationTurn[]>;
  //      run.onDidChangeStatus(cb); run.status; run.usage; run.requestId
  ```

  - `RunResult`: `{ status: "finished"|"error"|"cancelled", result?: string (final assistant text), error?: {message, code?}, model, durationMs, usage?: TokenUsage, git?: { branches: [{repoUrl, branch?, prUrl?}] }, requestId }`.
  - `SDKMessage` union: `system` (subtype "init", model?, tools?), `user`, `assistant` (message.content: TextBlock|ToolUseBlock[]), `thinking`, `tool_call` (`call_id, name, status: "running"|"completed"|"error", args?, result?, truncated?`), `status` (`CREATING|RUNNING|FINISHED|ERROR|CANCELLED|EXPIRED`), `task`, `request`, `usage`. Stability note: "Tool call schema is not stable … Treat args and result as unknown and parse defensively. The event envelope (type, call_id, name, status) is stable."
  - `SendOptions`: `model`, `mode: "agent"|"plan"`, `mcpServers` (fully replaces per run), `onStep`, `onDelta` (raw `InteractionUpdate`: text-delta, thinking-delta, tool-call-started/completed/delta, partial-tool-call, token-delta, step-started/completed, turn-ended, summary\*, shell-output-delta), `idempotencyKey`, `cloud.envVars`, `local.force`, `local.customTools`.
  - Statics: `Agent.list(options?)` (`{limit, cursor}` + `runtime: "local" {cwd?, store?}` | `"cloud" {prUrl?, includeArchived?, apiKey?}`) → `{items, nextCursor}`; `Agent.get(agentId)`; `Agent.listRuns(agentId)`; `Agent.getRun(runId)`; `Agent.cancelRun(runId)`; `Agent.messages.list(agentId, {limit, offset, runtime…})` → `AgentMessage {type: "user"|"assistant", uuid, agent_id, message}`; `Agent.archive/unarchive/delete(agentId)`; `Agent.getUsage(agentId, {runId?})` → `{usage, cost?: {rawCostCents, chargedCents}, runs: [{runId, usage, cost?}]}`.
  - `Cursor` namespace: `Cursor.me()`, `Cursor.models.list()` (returns `ModelListItem {id, displayName, description?, aliases?, parameters?[{id, displayName?, values:[{value, displayName?}]}], variants?[{params, displayName, description?, isDefault?}]}`), `Cursor.repositories.list()` (cloud only), `Cursor.configure({local: {store, useHttp1ForAgent, workspaceScanCacheTtlMs}})`, `Cursor.auth.*`.
  - AgentOptions highlights: `model: {id, params:[{id, value}]}` (e.g. `{id:"composer-2.5", params:[{id:"fast", value:"true"}]}`, Router `auto-smart` + `optimize_for`), `mode`, `local: {cwd, sandboxOptions:{enabled}, autoReview, customTools, settingSources: ["project"|"user"|"plugins"]}`, `cloud: {repos:[{url, startingRef, prUrl?}], autoCreatePR, envVars, metadata, env:{type:"cloud"|"pool"|"machine", name?}}`, `mcpServers` (McpServerConfig with `type: "http"|"stdio"`, `url`/`command`, `headers`, `auth`, `env`), `agents` (named subagents), `tools` / `disallowedTools` (local only).

- **Workspace bounds (local sandbox):** with `local.sandboxOptions.enabled: true` — "Writes are limited to the working directory (local.cwd) and a small set of allowed paths. Reads outside the workspace are blocked." Shell runs in bubblewrap (Linux) / seatbelt (macOS); "Network — Outbound network is denied by default. To allow specific hosts, drop a `.cursor/sandbox.json` in the workspace … The SDK reads the same per-user policy at `~/.cursor/sandbox.json`." Without sandbox, local agents run tool calls without approval — "there's no human-in-the-loop prompt in headless mode"; gate via hooks or `autoReview: true`. Cloud runs always execute in an isolated VM (`sandboxOptions` doesn't apply).
- **REST (Cloud Agents API) at `https://api.cursor.com`** — docs: https://cursor.com/docs/cloud-agent/api/endpoints. Auth: "accepts both Basic and Bearer authentication" (`-u YOUR_API_KEY:` or `Authorization: Bearer`). Endpoints:
  - `POST /v1/agents` (create agent + initial run; body: `prompt{text, images?}`, `model{id, params}`, `name`, `env{type: cloud|pool|machine, name}`, `repos[{url, startingRef?, prUrl?}]` (max 20), `workOnCurrentBranch`, `autoCreatePR`, `skipReviewerRequest`, `envVars` (beta; ≤50; names can't start `CURSOR_`), `mcpServers` (≤50; `type: http|sse|stdio`), `customSubagents` (≤20), `mode: plan|agent`, `agentId` (`bc-<uuid>`, idempotency — conflict returns `409 agent_id_conflict`))
  - `GET /v1/agents` (`limit` ≤100 default 20, `cursor`, `prUrl`, `includeArchived`; `nextCursor` omitted when no more pages), `GET /v1/agents/{id}` (status `ACTIVE|IDLE|ARCHIVED`)
  - `POST /v1/agents/{id}/runs` (follow-up; `409 agent_busy` if a run is active; `mode`, `mcpServers` replace), `GET /v1/agents/{id}/runs`, `GET /v1/agents/{id}/runs/{runId}` (`durationMs`, `result` text, `git.branches[]`)
  - `GET /v1/agents/{id}/runs/{runId}/stream` — **SSE**; events: `status`, `assistant`, `thinking`, `tool_call` (`ToolCallEventData {callId, name, status: "running"|"completed", args?, result?, truncated?}`; public tool names like `read_file`, `run_terminal_cmd`, `mcp`), `interaction_update` (full SDK-shape stream), `heartbeat`, `result`, `error`, `done`; resume via `Last-Event-ID`; `X-Cursor-Stream-Retention-Seconds` header; `410 stream_expired` after retention
  - `POST /v1/agents/{id}/runs/{runId}/cancel` (terminal; `409 run_not_cancellable`)
  - `GET /v1/agents/{id}/usage` (`?runId=`; usage fields `inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, totalTokens`)
  - `GET /v1/agents/{id}/artifacts`, `GET /v1/agents/{id}/artifacts/download?path=…` (15-min presigned S3 URL)
  - `POST /v1/agents/{id}/archive`, `POST /v1/agents/{id}/unarchive`, `DELETE /v1/agents/{id}` (permanent)
  - `POST /v1/sub-tokens` (1-hour user-scoped worker token; requires agent-scoped team service account key)
  - `GET /v1/me`, `GET /v1/models` (model catalog with `parameters`/`variants`; "Omit model … Cursor resolves your user default model, then your team default model, then a system default"), `GET /v1/repositories` (strict rate limits: 1/user/min, 30/user/hour)
  - Legacy `v0` private-worker endpoints (`/v0/private-workers*`) and v0 webhooks; v1 webhooks "coming soon".
  - Run status vocabulary: `CREATING, RUNNING, FINISHED, ERROR, CANCELLED, EXPIRED`.

## 8. Cursor ACP (Agent Client Protocol)

- **Yes — Cursor supports ACP.** Command: **`agent acp`** ("Start ACP server mode (advanced, hidden command)"). Docs: https://cursor.com/docs/cli/acp. Cursor is listed as an ACP agent at https://agentclientprotocol.com/get-started/agents (entry links to https://cursor.com/docs/cli/acp). There is **no `cursor/agent-client-protocol` GitHub repo** under the Cursor org (org repo listing verified 2026-08-30); the protocol spec lives at agentclientprotocol.com (Zed Industries et al.).
- **Transport/envelope (Cursor docs):** "Transport: stdio. Protocol envelope: JSON-RPC 2.0. Framing: newline-delimited JSON (one message per line)." Client → stdin (requests/notifications); Cursor CLI → stdout (responses/notifications); logs → stderr.
- **Protocol version:** current spec is **ACP v1 ("v1 Latest")** with `protocolVersion` as a single **integer**; `initialize` examples use `"protocolVersion": 1` (https://agentclientprotocol.com/protocol/v1/initialization). A **v2 is in draft** (https://agentclientprotocol.com/protocol/v2/overview; migration guide /protocol/v2/migration). Cursor's docs example sends `protocolVersion: 1`.
- **Typical flow (Cursor docs, https://cursor.com/docs/cli/acp):** `initialize` → `authenticate` with `methodId: "cursor_login"` → `session/new` (or `session/load`) → `session/prompt` → handle `session/update` notifications → handle `session/request_permission` → optionally `session/cancel`.
- **`initialize` request params (Cursor's minimal-client example):**
  ```json
  {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": 1,
      "clientCapabilities": {
        "fs": { "readTextFile": false, "writeTextFile": false },
        "terminal": false
      },
      "clientInfo": { "name": "acp-minimal-client", "version": "0.1.0" }
    }
  }
  ```
  ACP spec: agent responds with `protocolVersion`, `agentCapabilities` (`loadSession: true`, `promptCapabilities: {image, audio, embeddedContext}`, `mcpCapabilities: {http, sse}`), `agentInfo`, `authMethods` (https://agentclientprotocol.com/protocol/v1/initialization).
- **Sessions:** `session/new` with `{cwd, mcpServers, …}` → `{sessionId}`; `session/load` replays the whole conversation as `session/update` notifications (spec: https://agentclientprotocol.com/protocol/v1/session-setup). Cursor docs: "Resume an existing conversation with `session/load`." (Spec v1 also documents `session/resume` as restoring without replay; session list/delete pages exist: /protocol/v1/session-list, /protocol/v1/session-delete.)
- **Prompting:** `session/prompt {sessionId, prompt: [{type: "text", text}]}` → response `{stopReason: "end_turn"}` (also `"cancelled"` after cancel; spec https://agentclientprotocol.com/protocol/v1/prompt-turn).
- **`session/update` notification:** `params: { sessionId, update: { sessionUpdate: "<kind>", … } }` — kinds documented in spec/Cursor example: **`agent_message_chunk`** (with `content: {type:"text", text}`), **`plan`** (`entries: [{content, priority, status}]`), **`tool_call`** and **`tool_call_update`** (status in_progress/completed) (https://agentclientprotocol.com/protocol/v1/prompt-turn, /protocol/v1/agent-plan, /protocol/v1/tool-calls).
- **Permissions:** agent calls **`session/request_permission`**; Cursor docs: clients return one of **`allow-once`, `allow-always`, `reject-once`** — e.g. `{ "outcome": { "outcome": "selected", "optionId": "allow-once" } }`. ACP spec wire format uses option `kind: "allow_once" | "reject_once" | …` and outcome `"selected"`/`"cancelled"` (https://agentclientprotocol.com/protocol/v1/tool-calls). "If your client does not answer permission requests, tool execution can block."
- **Cancellation:** client notification `session/cancel {sessionId}`; agent responds to the original `session/prompt` with `stopReason: "cancelled"` (https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation).
- **Modes:** "ACP sessions support the same core modes as CLI: agent (full tool access), plan (planning, read-only behavior), ask (Q&A/read-only behavior)" (https://cursor.com/docs/cli/acp).
- **Cursor ACP extension methods** (https://cursor.com/docs/cli/acp):
  | Method | Type | Use |
  |---|---|---|
  | `cursor/ask_question` | Blocking | Multiple-choice questions; request `{toolCallId, title?, questions:[{id, prompt, options:[{id,label}], allowMultiple?}]}`, response `{outcome: {outcome:"answered", answers:[{questionId, selectedOptionIds}]} | {outcome:"skipped", reason?} | {outcome:"cancelled"}}` |
  | `cursor/create_plan` | Blocking | Plan approval; request `{toolCallId, name?, overview?, plan, todos:[{id, content, status}], isProject?, phases?}`; response `{outcome: "accepted" (planUri?) | "rejected" (reason?) | "cancelled"}` |
  | `cursor/update_todos` | Notification | `{toolCallId, todos[], merge: boolean}` |
  | `cursor/task` | Notification | Subagent task; `{toolCallId, description, prompt, subagentType, model?, agentId?, durationMs?}` |
  | `cursor/generate_image` | Notification | `{toolCallId, description, filePath?, referenceImagePaths?}` |
- **Auth in ACP:** "Cursor CLI advertises `cursor_login` as the ACP auth method"; pre-authenticate with `agent login`, `--api-key`/`CURSOR_API_KEY`, or `--auth-token`/`CURSOR_AUTH_TOKEN`. Endpoint/TLS options: `agent --api-key "***" acp`, `agent -e https://api2.cursor.sh acp`, `agent -k acp`.

## 9. Headless runs, output schema, worktrees, model selection

- **Headless docs:** https://cursor.com/docs/cli/headless ("Headless / CI" in nav). Key facts: use `-p/--print`; text format by default; `--output-format json` for structured single result; `--output-format stream-json` for NDJSON progress; `--stream-partial-output` for char-level deltas; images/video by **including file paths in the prompt text** (agent reads them via tools); GitHub Actions integration doc exists at https://cursor.com/docs/cli/github-actions.
- **`--output-format json` shape** (https://cursor.com/docs/cli/reference/output-format): single JSON object + newline on success only:
  ```json
  {
    "type": "result",
    "subtype": "success",
    "is_error": false,
    "duration_ms": 1234,
    "duration_api_ms": 1234,
    "result": "<full assistant text>",
    "session_id": "<uuid>",
    "request_id": "<optional>"
  }
  ```
  "On failure, the process exits with a non-zero code and writes an error message to stderr. **No well-formed JSON object is emitted in failure cases.**"
- **`--output-format stream-json` events** (same page): NDJSON, one object per line:
  - `{"type":"system","subtype":"init","apiKeySource":"env|flag|login","cwd":"…","session_id":"<uuid>","model":"<display name>","permissionMode":"default"}` — "Future fields like tools and mcp_servers may be added."
  - `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<prompt>"}]},"session_id":"…"}`
  - `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"<complete message text>"}]},"session_id":"…"}`
  - Tool calls: `{"type":"tool_call","subtype":"started","call_id":"…","tool_call":{"readToolCall":{"args":{"path":"file.txt"}}},"session_id":"…"}` and `subtype:"completed"` with `result.success` payloads (`readToolCall` → `{content, isEmpty, exceededLimit, totalLines, totalChars}`; `writeToolCall` → args `{path, fileText, toolCallId}`, result `{path, linesCreated, fileSize}`; "Other tools: may use `tool_call.function` structure with `{name, arguments}`").
  - Terminal: same `result` object as json format.
  - With `--stream-partial-output`, assistant events get `timestamp_ms` (streaming deltas) and `model_call_id` (pre-tool-call buffered flush) — dedupe rules documented (skip events lacking `timestamp_ms` and events having `model_call_id`).
  - Notes: "thinking events are suppressed in print mode"; "Field additions may occur over time in a backward-compatible way (consumers should ignore unknown fields)."
- **Git worktrees:** CLI flags `-w/--worktree [name]`, `--worktree-base <branch>`, `--skip-worktree-setup`; worktrees created under `~/.cursor/worktrees/<reponame>/<name>`. Setup scripts configured in `.cursor/worktrees.json` with keys `setup-worktree`, `setup-worktree-unix` (takes precedence on Unix), `setup-worktree-windows`; values are a command array or a script path; `$ROOT_WORKTREE_PATH` env available (https://cursor.com/docs/configuration/worktrees, https://cursor.com/docs/cli/reference/parameters). IDE/Agents-Window worktree features: `/worktree`, `/best-of-n`, `/apply-worktree`, `/delete-worktree`; cleanup settings `cursor.worktreeCleanupIntervalHours`, `cursor.worktreeMaxCount` (default cap 25/machine) — Cursor 3.5+ discovery behavior.
- **Model selection:** CLI `--model <model>` and `--list-models` / `agent models` (example: `agent -p "…" --model "gpt-5"`); modes `--mode plan|ask`. Cloud/SDK: `model: {id, params:[{id,value}]}` validated against `GET /v1/models` / `Cursor.models.list()` (Router = `auto-smart` with `optimize_for` param; default resolution order user → team → system default). Docs warn: "Discover, don't hard-code."

---

## MINIMUM VERSIONS & GAPS

Versions verified as of 2026-08-30:

- **Cursor CLI (agent):** installer build `2026.08.25-3e8eec8`; newest changelog entry Aug 11, 2026. Binary `agent`; install via `curl https://cursor.com/install -fsS | bash`. **No official npm package** — the npm `cursor-agent` package (1.0.3, zalab-inc) is unrelated to Anysphere.
- **`@cursor/sdk`:** 1.0.30 (2026-08-27), Node ≥ 22.13.
- **ACP:** protocol v1 (`protocolVersion: 1`) current; v2 draft. Cursor command `agent acp` (hidden).
- **IDE-referenced versions in docs:** `/migrate-to-skills` requires Cursor 2.4+; worktree discovery/cleanup described for Cursor 3.5+.

Capability gaps (explicitly not supported / not documented in official sources):

1. **No official npm distribution of the CLI** — installer script only; `cursor-agent` on npm is third-party.
2. **Commands format effectively deprecated in docs** — live page redirects to Skills FAQ; no frontmatter schema for `.cursor/commands/*.md` is documented anywhere current (no `model` field; the user-level commands directory path is not documented). Docs steer new work to Skills.
3. **Skills versioning:** no version field in SKILL.md frontmatter; only the open standard at agentskills.io is referenced. No Cursor-owned spec repo on GitHub.
4. **`--output-format json` has no failure JSON** — errors go to stderr with non-zero exit; consumers must handle that.
5. **stream-json tool-call payloads are not a stable contract** — docs say tool-specific shapes (`readToolCall`, `writeToolCall`, `function`) and that fields may be added ("ignore unknown fields"); `@cursor/sdk` docs repeat: "Tool call schema is not stable … parse defensively."
6. **CLI hooks coverage is not documented** — official docs don't state which hook events fire in CLI; the official forum reports only `beforeShellExecution`/`afterShellExecution` fire there (unverified by docs).
7. **`preToolUse` `"ask"` permission is accepted by schema but not enforced** (hooks docs); `subagentStart` treats `"ask"` as `"deny"`.
8. **ACP in Cursor:** team-level (dashboard) MCP servers are **not** supported in ACP mode; only project/user `.cursor/mcp.json`. `session/load` is documented (spec `agentCapabilities.loadSession`); the newer spec-v1 `session/resume` and session list/delete surfaces are spec features not mentioned on Cursor's page — don't assume Cursor implements them.
9. **`@cursor/sdk`:** local agents return **no artifacts** (`listArtifacts` empty / `downloadArtifact` throws); `tools`/`disallowedTools` and inline `mcpServers` don't persist across `Agent.resume()`; concurrent runs return `409 agent_busy` (cloud); `local.customTools` on cloud throws `ConfigurationError`; Team Admin API keys not supported; no raw model-inference/chat-completions endpoint ("Cursor does not currently document a raw Router endpoint for arbitrary model calls").
10. **Cloud REST API:** v1 webhooks "coming soon" (only legacy v0 has webhooks); `GET /v1/repositories` is rate-limited (1/min, 30/hour/user); `envVars` create field is beta and silently ignored if not enabled for the account.
11. **No official `github.com/cursor/agent-client-protocol` repo exists**; protocol spec and schemas live at agentclientprotocol.com.

## RECOMMENDED INTEGRATION DEFAULTS

1. **Editor embedding → ACP:** spawn `agent acp`, speak JSON-RPC 2.0 NDJSON over stdio, send `initialize` with `protocolVersion: 1` + `clientCapabilities`, then `authenticate {methodId: "cursor_login"}` (or pre-auth via `CURSOR_API_KEY`), `session/new {cwd, mcpServers: []}`, `session/prompt`, handle `session/update` (`agent_message_chunk`, `tool_call`/`tool_call_update`, `plan`), always answer `session/request_permission` (default `{outcome:{outcome:"selected", optionId:"allow-once"}}`), send `session/cancel` on user abort. Implement the five `cursor/*` extension methods defensively (they're Cursor-specific).
2. **Headless one-shot → CLI print mode:** `agent -p --output-format json …` and parse the single `result` object; treat non-zero exit as failure (stderr only). For progress: `--output-format stream-json` (add `--stream-partial-output` only if you need char deltas and implement the `timestamp_ms`/`model_call_id` dedupe). Ignore unknown JSON fields. Auto-approve with `--force` only in CI sandboxes; prefer `--sandbox enabled` + `--trust` for headless; pass `--approve-mcps` when MCP servers are pre-vetted.
3. **Sessions:** persist `session_id` from output events; resume with `--resume <chatId>` or `--continue`; use `agent ls`/`agent resume`/`agent create-chat` for session management.
4. **Programmatic orchestration → `@cursor/sdk`:** Node ≥ 22.13, `npm install @cursor/sdk`; `Agent.create({apiKey|CURSOR_API_KEY, model: {id, params}, local: {cwd, sandboxOptions: {enabled: true}}})`; `agent.send()` → `run.stream()`/`run.wait()`; resume with `Agent.resume(agentId)`; discover models via `Cursor.models.list()`. For fleet/CI, prefer the REST API `https://api.cursor.com/v1/agents` with Basic auth and the SSE run stream (`Last-Event-ID` resume; fall back to `GET …/runs/{runId}` on `410 stream_expired`). Handle `409 agent_busy`/`agent_id_conflict` with backoff. Use `cloud.metadata` for correlation IDs.
5. **Repo-level customization to ship in git:** `.cursor/rules/*.mdc` (explicit `alwaysApply`/`globs`/`description`), `.cursor/skills/<name>/SKILL.md` (`name` matches folder, rich `description`, `paths` when file-scoped), `.cursor/hooks.json` (command hooks, `failClosed: true` for security gates), `.cursor/mcp.json`, `.cursor/worktrees.json`, `AGENTS.md`.
6. **MCP distribution:** author `mcp.json`-format config; generate one-click deeplink `cursor://anysphere.cursor-deeplink/mcp/install?name=<NAME>&config=<base64(JSON.stringify(config))>`; for remote servers prefer Streamable HTTP + `headers` or static OAuth (`CLIENT_ID`/`CLIENT_SECRET`/`scopes`), registering both fixed redirect URLs; use `${env:VAR}` interpolation instead of literal secrets.
7. **Model selection:** never hardcode; resolve via `GET /v1/models` / `Cursor.models.list()` / `agent models` and validate `model.params` against the catalog; use Router (`auto-smart` + explicit `optimize_for`) as fallback.
8. **Auth hygiene:** `CURSOR_API_KEY` via secret store/env (never argv in shared logs — the CLI also accepts it as a flag, avoid that); CLI interactive auth via `agent login`; SDK-only hosts can use `Cursor.auth.login()` (stored at `~/.cursor/sdk/auth.json`, 90-day key).
