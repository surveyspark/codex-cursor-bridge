/**
 * Cursor ACP adapter: `cursor-agent acp` over stdio (Agent Client Protocol,
 * JSON-RPC 2.0). Selected when the Cursor CLI is installed and authenticated.
 *
 * Protocol behavior (per official Cursor docs and the ACP spec):
 * - initialize handshake with protocolVersion + clientCapabilities
 * - session/new (cwd) → sessionId
 * - session/prompt (sessionId, prompt blocks) → completion with stopReason
 * - session/update notifications: agent_message_chunk, tool_call,
 *   tool_call_update, plan, etc.
 * - session/request_permission server→client requests: RELAYED, never
 *   auto-approved. The bridge denies unless the underlying profile allows it.
 * - session/cancel for cancellation.
 * - session ids are preserved for follow-up (session/prompt on the same
 *   session within one connection; session/load when supported).
 */

import {
  BridgeError,
  JsonLineReader,
  JsonRpcConnection,
  buildChildEnv,
  redactString,
  resolveCursorCliName,
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

const ACP_PROTOCOL_VERSION = 1; // ACP current protocol version (integer)
const INIT_TIMEOUT_MS = 30_000;

export interface CursorAcpAdapterOptions {
  cursorBinaryPath?: string;
  /** Test hook: argv override to spawn a fake ACP agent. */
  argvOverride?: string[];
}

export class CursorAcpAdapter implements AgentAdapter {
  readonly name = "cursor-acp" as const;

  constructor(private readonly opts: CursorAcpAdapterOptions = {}) {}

  private binaryName = "agent";
  private resolved = false;

  /**
   * Official Cursor CLI binary is `agent` (installed via cursor.com/install —
   * there is NO official npm package). `cursor-agent` is accepted as a legacy
   * alias; explicit config (cursorBinaryPath / CCB_CURSOR_BINARY) always wins.
   */
  private async ensureBinary(): Promise<void> {
    if (this.resolved) return;
    if (this.opts.cursorBinaryPath) {
      this.binaryName = this.opts.cursorBinaryPath;
    } else if (process.env.CCB_CURSOR_BINARY) {
      this.binaryName = process.env.CCB_CURSOR_BINARY;
    } else {
      this.binaryName = await resolveCursorCliName();
    }
    this.resolved = true;
  }

  private argvBase(): string[] {
    if (this.opts.argvOverride) return this.opts.argvOverride;
    return [this.binaryName, "acp"];
  }

  async cursorCliVersion(): Promise<string | null> {
    if (this.opts.argvOverride) return "test-fake";
    await this.ensureBinary();
    try {
      const { stdout } = await execFileAsync(this.binaryName, ["--version"], {
        timeout: 10_000,
      });
      return stdout.trim();
    } catch {
      return null;
    }
  }

  async isAvailable(): Promise<AdapterAvailability> {
    if (this.opts.argvOverride)
      return { available: true, version: "test-fake" };
    const version = await this.cursorCliVersion();
    if (!version) {
      return {
        available: false,
        reason:
          "Cursor CLI not found on PATH (install: curl https://cursor.com/install -fsS | bash)",
      };
    }
    return { available: true, version };
  }

  describeCapabilities(): AdapterCapabilities {
    return {
      nativeId: "session",
      continuation: true,
      structuredEvents: true,
      approvals: "relayed",
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
    await this.ensureBinary();
    // One connection per prompt keeps abort handling in a single place:
    // session/new happens here, then promptAndCollect runs the prompt on a
    // fresh connection with session/load continuation.
    return await this.promptAndCollect({
      sessionId: "",
      prompt: buildTaskPrompt(request, "cursor"),
      ctx,
      spawned: () => {},
      request,
    });
  }

  /** One connection per prompt; follow-ups re-attach via session/load when supported. */
  private async promptAndCollect(args: {
    sessionId: string;
    prompt: string;
    ctx: AdapterRunContext;
    spawned: (p: ReturnType<typeof spawnProcess>) => void;
    request: StartRequest;
  }): Promise<JobResult> {
    const { sessionId, prompt, ctx } = args;
    await this.ensureBinary();
    const startedAt = new Date().toISOString();
    const child = spawnProcess({
      cwd: ctx.cwd,
      argv: this.argvBase(),
      env: buildChildEnv(["CURSOR_API_KEY"]),
      onStdoutLine: (line) => reader.pushLine(line),
      onStderrLine: (line) =>
        ctx.emit({
          type: "cursor-acp.stderr",
          level: "debug",
          data: { line: redactString(line) },
        }),
      abortSignal: ctx.abortSignal,
    });
    args.spawned(child);

    let finalText = "";
    let stopReason: string | null = null;

    const rpc = new JsonRpcConnection({
      send: (line) => child.child.stdin?.write(line + "\n"),
      onNotification: (msg) => {
        const params = (msg.params ?? {}) as Record<string, unknown>;
        if (msg.method === "session/update") {
          const update = params.update as Record<string, unknown> | undefined;
          if (update?.sessionUpdate === "agent_message_chunk") {
            const content = update.content as { text?: string } | undefined;
            if (content && typeof content.text === "string")
              finalText += content.text;
          }
        }
      },
      onServerRequest: async (msg) => {
        if (msg.method === "session/request_permission") {
          const params = (msg.params ?? {}) as Record<string, unknown>;
          const options =
            (params.options as Array<{ kind?: string; optionId?: string }>) ??
            [];
          const denyOption =
            options.find((o) => o.kind === "reject_once") ?? options.at(-1);
          ctx.approval({
            ts: new Date().toISOString(),
            kind: "session/request_permission",
            summary: redactString(
              JSON.stringify(params.options ?? {}).slice(0, 500),
            ),
            decision: "auto-denied",
            reason: "bridge policy: permission escalations are denied",
          });
          return {
            outcome: {
              outcome: "selected",
              optionId: denyOption?.optionId ?? null,
            },
          };
        }
        return {};
      },
      onClose: () => rpc.close(),
    });

    const reader = new JsonLineReader({
      onMessage: (msg) => {
        rpc.handleLine(
          typeof msg === "string" ? msg : JSON.stringify(msg),
          reader,
        );
      },
    });

    await rpc.request(
      "initialize",
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
        },
      },
      INIT_TIMEOUT_MS,
    );
    rpc.notify("initialized");

    // New session or continuation of an existing one.
    let activeSession = sessionId;
    if (!activeSession) {
      const created = (await rpc.request(
        "session/new",
        { cwd: ctx.cwd, mcpServers: [] },
        INIT_TIMEOUT_MS,
      )) as {
        sessionId?: string;
      } | null;
      if (!created?.sessionId) {
        throw new BridgeError(
          "ADAPTER_PROTOCOL_ERROR",
          "session/new returned no sessionId",
        );
      }
      activeSession = created.sessionId;
      ctx.onNativeId(activeSession);
    } else {
      try {
        const loaded = (await rpc.request(
          "session/load",
          { sessionId, cwd: ctx.cwd, mcpServers: [] },
          INIT_TIMEOUT_MS,
        )) as {
          sessionId?: string;
        } | null;
        if (loaded?.sessionId) activeSession = loaded.sessionId;
      } catch {
        // session/load unsupported: continue with the same id anyway.
      }
    }

    let promptResult: { stopReason?: string } | null = null;
    try {
      promptResult = (await Promise.race([
        rpc.request(
          "session/prompt",
          {
            sessionId: activeSession,
            prompt: [{ type: "text", text: prompt }],
          },
          0,
        ),
        child.done.then(() => null),
      ])) as { stopReason?: string } | null;
    } finally {
      // Ensure the child never outlives the prompt (fakes and real agents
      // keep stdin open; the transport is done once the turn ends).
      rpc.close();
      await child.killTree().catch(() => {});
    }
    stopReason = promptResult?.stopReason ?? null;

    const exit = await child.done.catch(() => ({ code: null }));
    const finishedAt = new Date().toISOString();

    if (ctx.abortSignal.aborted) {
      return {
        jobId: ctx.jobId,
        nativeId: activeSession,
        adapter: this.name,
        status: "cancelled",
        summary: "Cursor ACP run cancelled.",
        continuation: {
          supported: true,
          how: `cursor_reply with nativeId=${activeSession} (ACP session)`,
        },
        startedAt,
        finishedAt,
        failure: { code: "JOB_CANCELLED", message: "aborted", retriable: true },
      };
    }

    // A non-zero exit only matters when the prompt never completed: after a
    // finished turn the bridge terminates the transport itself (taskkill /F
    // on Windows yields exit code 1), which is expected, not a failure.
    const promptCompleted = promptResult !== null;
    if (!promptCompleted && exit.code !== 0 && exit.code !== null) {
      return {
        jobId: ctx.jobId,
        nativeId: activeSession,
        adapter: this.name,
        status: "failed",
        summary: `cursor-agent acp exited with code ${exit.code}.`,
        continuation: {
          supported: true,
          how: `cursor_reply with nativeId=${activeSession} (ACP session)`,
        },
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
      nativeId: activeSession,
      adapter: this.name,
      status: stopReason === "refusal" ? "failed" : "completed",
      summary: (finalText || "(cursor agent produced no message text)").slice(
        0,
        10_000,
      ),
      continuation: {
        supported: true,
        how: `cursor_reply with nativeId=${activeSession} (ACP session)`,
      },
      startedAt,
      finishedAt,
      failure:
        stopReason === "refusal"
          ? {
              code: "ADAPTER_PROTOCOL_ERROR",
              message: "agent refused",
              retriable: false,
            }
          : null,
    };
  }

  async reply(
    nativeId: string,
    message: string,
    ctx: AdapterRunContext,
  ): Promise<JobResult> {
    // Follow-up: same flow with a session/load + short prompt.
    const result = await this.promptAndCollect({
      sessionId: nativeId,
      prompt: message,
      ctx,
      spawned: () => {},
      request: {
        task: message,
        cwd: ctx.cwd,
        mode: "implement",
        permissionProfile: "read-only",
        background: false,
      },
    });
    return result;
  }
}
