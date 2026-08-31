/**
 * Cursor non-interactive CLI fallback: `cursor-agent -p <task> --output-format json`.
 *
 * WARNING (documented in doctor, README, and skill instructions): per official
 * Cursor docs, "Cursor has full write access in non-interactive mode". The
 * bridge therefore:
 * - requires explicit opt-in (config.allowNonInteractiveCliFallback or
 *   --allow-noninteractive-cli),
 * - injects strong constraints into the prompt,
 * - passes the prompt via stdin (never as a shell-expanded argument),
 * - parses only the documented JSON output schema.
 */

import {
  buildChildEnv,
  spawnProcess,
  type JobResult,
  type StartRequest,
} from "@codex-cursor-bridge/bridge-core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  AdapterAvailability,
  AdapterCapabilities,
  AdapterRunContext,
  AgentAdapter,
} from "./types.js";
import { buildTaskPrompt } from "./prompt.js";

const execFileAsync = promisify(execFile);

export interface CursorCliFallbackAdapterOptions {
  cursorBinaryPath?: string;
  allowNonInteractive: boolean;
  /** Test hook: argv override to spawn a fake CLI. */
  argvOverride?: string[];
}

interface StreamEvent {
  type?: string;
  session_id?: string;
  result?: string;
  error?: unknown;
  [k: string]: unknown;
}

export class CursorCliFallbackAdapter implements AgentAdapter {
  readonly name = "cursor-cli-fallback" as const;

  constructor(private readonly opts: CursorCliFallbackAdapterOptions) {}

  private binary(): string {
    if (this.opts.argvOverride) return this.opts.argvOverride[0]!;
    return (
      this.opts.cursorBinaryPath ??
      process.env.CCB_CURSOR_BINARY ??
      "cursor-agent"
    );
  }

  private baseArgs(): string[] {
    if (this.opts.argvOverride) return this.opts.argvOverride.slice(1);
    return [];
  }

  async isAvailable(): Promise<AdapterAvailability> {
    if (!this.opts.allowNonInteractive) {
      return {
        available: false,
        reason:
          "non-interactive CLI fallback requires explicit opt-in (config allowNonInteractiveCliFallback=true)",
      };
    }
    if (this.opts.argvOverride)
      return { available: true, version: "test-fake" };
    try {
      const { stdout } = await execFileAsync(this.binary(), ["--version"], {
        timeout: 10_000,
      });
      return { available: true, version: stdout.trim() };
    } catch {
      return { available: false, reason: "cursor-agent CLI not found on PATH" };
    }
  }

  describeCapabilities(): AdapterCapabilities {
    return {
      nativeId: "session",
      continuation: true,
      structuredEvents: false,
      approvals: "none",
      sandboxProfiles: [
        "read-only",
        "isolated-workspace-write",
        "current-workspace-write",
      ],
      modes: [
        "investigate",
        "review",
        "adversarial-review",
        "rescue",
        "plan",
        "implement",
      ],
    };
  }

  async run(request: StartRequest, ctx: AdapterRunContext): Promise<JobResult> {
    const startedAt = new Date().toISOString();
    const prompt = buildTaskPrompt(request, "cursor");

    const argv = [
      this.binary(),
      ...this.baseArgs(),
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
    ];

    let sessionId: string | null = null;
    let resultText: string | null = null;
    let eventType: string | null = null;

    const child = spawnProcess({
      cwd: ctx.cwd,
      argv,
      env: buildChildEnv(["CURSOR_API_KEY"]),
      stdinData: prompt,
      onStdoutLine: (line) => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          return; // decorative output
        }
        const ev = parsed as StreamEvent;
        if (typeof ev.session_id === "string") {
          if (!sessionId) ctx.onNativeId(ev.session_id);
          sessionId = ev.session_id;
        }
        if (typeof ev.type === "string") {
          eventType = ev.type;
          ctx.emit({
            type: "cursor-cli.event",
            level: "debug",
            data: { type: ev.type },
          });
        }
        if (eventType === "result" && typeof ev.result === "string") {
          resultText = ev.result;
        }
      },
      onStderrLine: (line) => {
        ctx.emit({ type: "cursor-cli.stderr", level: "debug", data: { line } });
      },
      abortSignal: ctx.abortSignal,
    });

    const exit = await child.done;
    const finishedAt = new Date().toISOString();

    if (ctx.abortSignal.aborted || exit.timedOut) {
      return {
        jobId: ctx.jobId,
        nativeId: sessionId,
        adapter: this.name,
        status: ctx.abortSignal.aborted ? "cancelled" : "timed-out",
        summary: "Cursor CLI run cancelled/timed out.",
        continuation: sessionId
          ? {
              supported: true,
              how: `resume natively with \`cursor-agent --resume ${sessionId}\``,
            }
          : { supported: false, how: "no session id captured" },
        startedAt,
        finishedAt,
        failure: { code: "JOB_CANCELLED", message: "aborted", retriable: true },
      };
    }

    if (exit.code !== 0) {
      return {
        jobId: ctx.jobId,
        nativeId: sessionId,
        adapter: this.name,
        status: "failed",
        summary: `cursor-agent exited with code ${exit.code}; per official docs, no JSON is emitted on failure (see stderr events).`,
        continuation: { supported: false, how: "no session id on failure" },
        startedAt,
        finishedAt,
        failure: {
          code: "CHILD_EXITED",
          message: `exit code ${exit.code}`,
          retriable: false,
        },
      };
    }

    return {
      jobId: ctx.jobId,
      nativeId: sessionId,
      adapter: this.name,
      status: "completed",
      summary: (resultText ?? "(no result event captured)").slice(0, 10_000),
      continuation: sessionId
        ? {
            supported: true,
            how: `resume natively with \`cursor-agent --resume ${sessionId}\`; follow-ups via a new bridge job with this session id`,
          }
        : { supported: false, how: "no session id captured" },
      startedAt,
      finishedAt,
      failure: null,
    };
  }
}
