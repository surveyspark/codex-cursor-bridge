/**
 * `codex exec` one-shot fallback adapter.
 *
 * Documented limitations (honest by design):
 * - One-shot only: no true thread continuation. `codex exec resume <id>` can
 *   continue a recorded session, but the exec surface does not preserve a
 *   live interactive thread; the bridge reports continuation.how with the
 *   exec resume command and marks continuation.supported=false for tools.
 * - Events come from `--json` NDJSON on stdout; older CLIs may not support
 *   every event shape — parsing is defensive and forward-compatible.
 *
 * Never uses `codex mcp-server` (deprecated) and never uses a shell string.
 */

import {
  buildChildEnv,
  redactString,
  spawnProcess,
  type JobResult,
  type StartRequest,
} from "@codex-cursor-bridge/bridge-core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AdapterAvailability, AdapterCapabilities, AdapterRunContext, AgentAdapter } from "./types.js";
import { mapProfileToSandbox } from "./sandbox.js";
import { buildTaskPrompt } from "./prompt.js";
import { extractChangedFiles, extractTests } from "./normalize.js";

const execFileAsync = promisify(execFile);

export interface CodexExecAdapterOptions {
  codexBinaryPath?: string;
  /** Extra args inserted before the prompt (used by tests to point at fakes). */
  extraArgs?: string[];
  extraEnv?: Record<string, string>;
  /** Test/demo hook: full argv override to spawn a fake CLI. */
  argvOverride?: string[];
}

interface ExecEvent {
  msg?: { type?: string; payload?: Record<string, unknown> };
  [k: string]: unknown;
}

export class CodexExecAdapter implements AgentAdapter {
  readonly name = "codex-exec-fallback" as const;

  constructor(private readonly opts: CodexExecAdapterOptions = {}) {}

  private binary(): string {
    if (this.opts.argvOverride) return this.opts.argvOverride[0]!;
    return this.opts.codexBinaryPath ?? process.env.CCB_CODEX_BINARY ?? "codex";
  }

  private execArgs(): string[] {
    if (this.opts.argvOverride) return this.opts.argvOverride.slice(1);
    return ["exec"];
  }

  async isAvailable(): Promise<AdapterAvailability> {
    try {
      const { stdout } = await execFileAsync(this.binary(), ["--version"], { timeout: 10_000 });
      return { available: true, version: stdout.trim() };
    } catch {
      return { available: false, reason: "codex CLI not found" };
    }
  }

  describeCapabilities(): AdapterCapabilities {
    return {
      nativeId: "session",
      continuation: false,
      structuredEvents: true,
      approvals: "auto-denied",
      sandboxProfiles: ["read-only", "isolated-workspace-write", "current-workspace-write"],
      modes: ["investigate", "review", "adversarial-review", "rescue", "plan", "implement"],
    };
  }

  async run(request: StartRequest, ctx: AdapterRunContext): Promise<JobResult> {
    const startedAt = new Date().toISOString();
    const sandbox = mapProfileToSandbox(request.permissionProfile, ctx.cwd, ctx.networkPolicy);
    const argv = [
      this.binary(),
      ...this.execArgs(),
      "--json",
      "--sandbox",
      sandbox.sandboxMode,
      "--skip-git-repo-check",
      "-C",
      ctx.cwd,
      ...(request.model ? ["-m", request.model] : []),
      ...(this.opts.extraArgs ?? []),
    ];

    const events: ExecEvent[] = [];
    let lastAgentMessage: string | null = null;
    let threadId: string | null = null;

    const handleLine = (line: string): void => {
      if (line.length === 0) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return; // non-JSON noise is ignored (decorative output)
      }
      const ev = parsed as ExecEvent;
      events.push(ev);
      const msgType = ev.msg?.type;
      if (msgType === "agent_message" && typeof (ev.msg!.payload as { message?: unknown })?.message === "string") {
        lastAgentMessage = (ev.msg!.payload as { message: string }).message;
      } else if (msgType === "thread_started") {
        const payload = ev.msg!.payload as { thread_id?: string };
        if (payload.thread_id) threadId = payload.thread_id;
      } else if (msgType === "session_configured") {
        const payload = ev.msg!.payload as { session_id?: string };
        if (payload.session_id && !threadId) threadId = payload.session_id;
      }
    };

    const handleStdoutEnd = (): void => {
      /* handled via exit */
    };
    void handleStdoutEnd;

    const child = spawnProcess({
      cwd: ctx.cwd,
      argv,
      env: buildChildEnv(["OPENAI_API_KEY", "CODEX_HOME"], this.opts.extraEnv),
      stdinData: buildTaskPrompt(request, "codex"),
      onStdoutLine: handleLine,
      onStderrLine: (line) => {
        ctx.emit({ type: "codex-exec.stderr", level: "debug", data: { line: redactString(line) } });
      },
      abortSignal: ctx.abortSignal,
    });

    const exit = await child.done;
    const finishedAt = new Date().toISOString();

    if (exit.timedOut || ctx.abortSignal.aborted) {
      return {
        jobId: ctx.jobId,
        nativeId: threadId,
        adapter: this.name,
        status: ctx.abortSignal.aborted ? "cancelled" : "timed-out",
        summary: "codex exec run was cancelled/timed out before completion.",
        continuation: { supported: false, how: "one-shot fallback: no live thread continuation" },
        startedAt,
        finishedAt,
        failure: { code: "JOB_CANCELLED", message: "aborted", retriable: true },
      };
    }

    if (exit.code !== 0) {
      return {
        jobId: ctx.jobId,
        nativeId: threadId,
        adapter: this.name,
        status: "failed",
        summary: `codex exec exited with code ${exit.code}.`,
        continuation: { supported: false, how: "one-shot fallback: no live thread continuation" },
        startedAt,
        finishedAt,
        failure: { code: "CHILD_EXITED", message: `exit code ${exit.code}`, retriable: exit.code !== 2 },
      };
    }

    const commands = events
      .filter((e) => e.msg?.type === "exec_command_end" || e.msg?.type === "exec_command_begin")
      .map((e) => {
        const payload = e.msg!.payload as { command?: unknown; exit_code?: unknown };
        const commandStr = Array.isArray(payload.command) ? (payload.command as string[]).join(" ") : String(payload.command ?? "");
        const exitCode = typeof payload.exit_code === "number" ? payload.exit_code : null;
        return {
          command: commandStr,
          exitCode,
          aggregatedStatus: exitCode === null ? ("unknown" as const) : exitCode === 0 ? ("success" as const) : ("failure" as const),
        };
      })
      .slice(0, 200);

    const changed = extractChangedFiles(
      events
        .filter((e) => e.msg?.type === "patch_apply_end")
        .map((e) => ({ item: { type: "fileChange", changes: (e.msg!.payload as { changes?: unknown }).changes ?? [] }, kind: "fileChange" })),
    );

    const tests = extractTests(commands);
    const result: JobResult = {
      jobId: ctx.jobId,
      nativeId: threadId,
      adapter: this.name,
      status: "completed",
      summary: (lastAgentMessage ?? "(codex exec returned no final message)").slice(0, 10_000),
      continuation: {
        supported: false,
        how: threadId
          ? `one-shot fallback: inspect/continue manually with \`codex exec resume ${threadId}\` or \`codex resume\``
          : "one-shot fallback: no live thread continuation",
      },
      startedAt,
      finishedAt,
      failure: null,
    };
    if (commands.length) result.commands = commands;
    if (changed.length) result.changedFiles = changed;
    if (tests.length) result.tests = tests;
    return result;
  }
}
