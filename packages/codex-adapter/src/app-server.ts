/**
 * Codex adapter via `codex app-server` (official stdio JSON-RPC transport).
 *
 * Protocol facts verified against codex-cli 0.145.0 by generating the
 * official JSON Schemas locally (`codex app-server generate-json-schema`):
 *
 * - initialize:  { clientInfo: { name, version, title? }, capabilities? }
 *                → { codexHome, platformFamily, platformOs, userAgent }
 * - thread/start: { cwd?, model?, sandbox?, approvalPolicy?, config?, ... }
 *                → { thread: { id, ... }, model, sandbox, approvalPolicy, ... }
 *                notifications: thread/started { thread }
 * - turn/start:  { threadId, input: [{ type: "text", text }], model?,
 *                  effort?, sandboxPolicy? }
 *                notifications: turn/started {threadId, turn},
 *                  item/started, item/completed {threadId, turnId, item},
 *                  item/agentMessage/delta {threadId, turnId, itemId, delta},
 *                  thread/tokenUsage/updated, turn/completed {threadId, turn}
 * - turn/interrupt: { threadId, turnId }
 * - thread/resume: { threadId } → { thread } (also thread/loaded/list etc.)
 * - server→client requests: execCommandApproval, applyPatchApproval,
 *                item/commandExecution/requestApproval,
 *                item/fileChange/requestApproval
 * - Thread.id: Codex-generated UUIDv7; sessionId is also present.
 * - SandboxMode: "read-only" | "workspace-write" | "danger-full-access"
 * - AskForApproval: "untrusted" | "on-request" | "never"
 * - SandboxPolicy (turn/start): { type: "readOnly", networkAccess?: boolean }
 *                | { type: "workspaceWrite", networkAccess?: boolean,
 *                    writableRoots?: string[], ... } | { type: "dangerFullAccess" }
 * - ThreadItem types include: userMessage, agentMessage, plan, reasoning,
 *                commandExecution (command, aggregatedOutput, exitCode),
 *                fileChange, mcpToolCall, webSearch, error
 *
 * Unknown notifications are ignored (forward compatibility). Any protocol
 * mismatch is surfaced as ADAPTER_PROTOCOL_ERROR with the raw method name.
 */

import {
  BridgeError,
  JsonLineReader,
  JsonRpcConnection,
  buildChildEnv,
  redactString,
  spawnProcess,
  type JobResult,
  type StartRequest,
} from "@codex-cursor-bridge/bridge-core";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import type {
  AdapterAvailability,
  AdapterCapabilities,
  AdapterRunContext,
  AgentAdapter,
} from "./types.js";
import { mapProfileToSandbox } from "./sandbox.js";
import { buildTaskPrompt } from "./prompt.js";
import { extractChangedFiles, extractCommands } from "./normalize.js";

const execFileAsync = promisify(execFile);

const INIT_TIMEOUT_MS = 30_000;
const TURN_START_TIMEOUT_MS = 120_000;

export interface CodexAppServerAdapterOptions {
  /** Path override for the codex binary. */
  codexBinaryPath?: string;
  /** Forward these env var names to the codex process. */
  forwardEnv?: string[];
  /** Extra env for the codex process (used by tests). */
  extraEnv?: Record<string, string>;
  /** Test/demo hook: full argv override to spawn a fake app-server. */
  argvOverride?: string[];
}

interface ThreadInfo {
  id: string;
  sessionId?: string | null;
  turnId: string | null;
}

export class CodexAppServerAdapter implements AgentAdapter {
  readonly name = "codex-app-server" as const;

  constructor(private readonly opts: CodexAppServerAdapterOptions = {}) {}

  private binary(): string {
    return this.opts.codexBinaryPath ?? process.env.CCB_CODEX_BINARY ?? "codex";
  }

  async codexVersion(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync(this.binary(), ["--version"], { timeout: 10_000 });
      return stdout.trim().split(/\s+/).pop() ?? stdout.trim();
    } catch {
      return null;
    }
  }

  private argv(): string[] {
    if (this.opts.argvOverride) return this.opts.argvOverride;
    return [this.binary(), "app-server"];
  }

  async isAvailable(): Promise<AdapterAvailability> {
    if (this.opts.argvOverride) return { available: true, version: "test-fake" };
    const version = await this.codexVersion();
    if (!version) {
      return { available: false, reason: "codex CLI not found on PATH" };
    }
    // A real availability probe happens in doctor via initialize round-trip;
    // here we only require the binary plus auth presence.
    return { available: true, version };
  }

  describeCapabilities(): AdapterCapabilities {
    return {
      nativeId: "thread",
      continuation: true,
      structuredEvents: true,
      approvals: "relayed",
      sandboxProfiles: ["read-only", "isolated-workspace-write", "current-workspace-write"],
      modes: ["investigate", "review", "adversarial-review", "rescue", "plan", "implement"],
    };
  }

  /**
   * Run an initialize round-trip against a fresh app-server process.
   * Used by doctor as a harmless auth/protocol readiness check.
   */
  async probe(): Promise<{ ok: boolean; detail: string; userAgent?: string }> {
    const holder: { p: ReturnType<typeof spawnProcess> | null } = { p: null };
    try {
      const conn = await this.connect(
        {
          emit: () => {},
          approval: () => {},
          jobId: "probe",
          cwd: os.tmpdir(),
          abortSignal: new AbortController().signal,
          onNativeId: () => {},
          debugLogging: false,
          networkPolicy: "denied",
          maxOutputBytes: 1_000_000,
        },
        (p) => {
          holder.p = p;
        },
      );
      const init = (await conn.rpc.request(
        "initialize",
        { clientInfo: { name: "codex-cursor-bridge", title: "codex-cursor-bridge", version: "0.1.0" } },
        INIT_TIMEOUT_MS,
      )) as { userAgent?: string } | null;
      conn.shutdown();
      return { ok: true, detail: "initialize succeeded", ...(init?.userAgent ? { userAgent: init.userAgent } : {}) };
    } catch (err) {
      holder.p?.killTree().catch(() => {});
      const be = err as { message?: string; code?: string };
      return { ok: false, detail: `${be.code ?? "ADAPTER_INIT_FAILED"}: ${be.message ?? String(err)}` };
    }
  }

  private async connect(
    ctx: AdapterRunContext,
    onSpawn?: (p: ReturnType<typeof spawnProcess>) => void,
  ): Promise<{
    rpc: JsonRpcConnection;
    threads: Map<string, ThreadInfo>;
    waitExit: Promise<void>;
    shutdown: () => void;
    lastAgentMessage: () => string | null;
    items: () => Array<{ item: Record<string, unknown>; kind: string }>;
    usages: () => Array<Record<string, unknown>>;
    turnErrors: () => Array<Record<string, unknown>>;
  }> {
    const child = spawnProcess({
      cwd: ctx.cwd,
      argv: this.argv(),
      env: buildChildEnv(
        [
          ...(this.opts.forwardEnv ?? ["OPENAI_API_KEY", "CODEX_HOME", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]),
        ],
        this.opts.extraEnv,
      ),
      onStdoutLine: (line) => reader.push(line),
      onStderrLine: (line) => {
        ctx.emit({ type: "codex.stderr", level: "debug", data: { line: redactString(line) } });
      },
      abortSignal: ctx.abortSignal,
    });
    onSpawn?.(child);

    const items: Array<{ item: Record<string, unknown>; kind: string }> = [];
    const usages: Array<Record<string, unknown>> = [];
    const turnErrors: Array<Record<string, unknown>> = [];
    let lastAgentMessage: string | null = null;
    const threads = new Map<string, ThreadInfo>();

    const rpc = new JsonRpcConnection({
      send: (line) => {
        if (child.child.stdin?.writable) {
          child.child.stdin.write(line + "\n");
        } else {
          throw new Error("codex app-server stdin closed");
        }
      },
      onNotification: (msg) => {
        const params = (msg.params ?? {}) as Record<string, unknown>;
        switch (msg.method) {
          case "thread/started": {
            const thread = params.thread as Record<string, unknown> | undefined;
            if (thread && typeof thread.id === "string") {
              threads.set(thread.id, {
                id: thread.id,
                sessionId: typeof thread.sessionId === "string" ? thread.sessionId : null,
                turnId: null,
              });
              ctx.onNativeId(thread.id);
            }
            break;
          }
          case "turn/started": {
            const threadId = params.threadId as string | undefined;
            const turn = params.turn as Record<string, unknown> | undefined;
            const t = threadId ? threads.get(threadId) : undefined;
            if (t && turn && typeof turn.id === "string") t.turnId = turn.id;
            ctx.emit({ type: "turn.started", data: { threadId } });
            break;
          }
          case "item/started": {
            const item = params.item as Record<string, unknown> | undefined;
            if (item) {
              ctx.emit({ type: "item.started", data: { type: item.type, id: item.id } });
            }
            break;
          }
          case "item/agentMessage/delta": {
            // Text deltas are too granular to persist individually; the
            // completed item carries the full text.
            break;
          }
          case "item/completed": {
            const item = params.item as Record<string, unknown> | undefined;
            if (item && typeof item.type === "string") {
              items.push({ item, kind: item.type });
              if (item.type === "agentMessage" && typeof item.text === "string") {
                lastAgentMessage = item.text;
              }
              ctx.emit({ type: "item.completed", data: summarizeItem(item) });
            }
            break;
          }
          case "thread/tokenUsage/updated": {
            usages.push(params);
            break;
          }
          case "turn/completed": {
            ctx.emit({ type: "turn.completed", data: { threadId: params.threadId } });
            break;
          }
          case "error": {
            turnErrors.push(params);
            ctx.emit({ type: "codex.error", level: "error", data: params });
            break;
          }
          case "turn/diff/updated": {
            ctx.emit({ type: "turn.diff.updated", data: { unifiedDiff: typeof params.unifiedDiff === "string" ? params.unifiedDiff : undefined } });
            break;
          }
          default:
            // Unknown notifications are ignored for forward compatibility.
            if (ctx.debugLogging) {
              ctx.emit({ type: "codex.unknown-notification", level: "debug", data: { method: msg.method } });
            }
        }
      },
      onServerRequest: async (msg) => {
        // Approval requests from Codex. The bridge never silently approves
        // destructive actions; with approvalPolicy "never" Codex should not
        // send these, but if it does we deny safely.
        const params = (msg.params ?? {}) as Record<string, unknown>;
        const kind = msg.method;
        const summary =
          kind === "execCommandApproval"
            ? `exec: ${String((params as { command?: unknown }).command ?? params.command ?? "unknown command")}`
            : kind === "applyPatchApproval"
              ? "apply patch"
              : `codex server request: ${kind}`;
        ctx.emit({ type: "approval.request", level: "warn", data: { kind, summary: redactString(summary) } });
        ctx.approval({
          ts: new Date().toISOString(),
          kind,
          summary: redactString(summary),
          decision: "auto-denied",
          reason: "bridge runs Codex with approvalPolicy=never and narrow sandbox; escalation requests are denied",
        });
        // Response shapes: { decision: "approved" | "denied" } historically;
        // current schema uses reviewDecision "approved"|"denied" etc. Send the
        // union-safe minimal denial.
        return { decision: "denied", reviewDecision: "denied" };
      },
      onClose: () => {
        rpc.close();
      },
    });

    const rpcRef = rpc;
    const reader = new JsonLineReader({
      onMessage: (msg) => {
        rpcRef.handleLine(typeof msg === "string" ? msg : JSON.stringify(msg), reader);
      },
      onMalformed: (err) => {
        ctx.emit({ type: "codex.malformed-json", level: "warn", data: { error: String(err) } });
      },
      onOversized: () => {
        ctx.emit({ type: "codex.oversized-message", level: "warn" });
      },
    });

    const waitExit = child.done
      .then((outcome) => {
        reader.end();
        rpc.close();
        if (outcome.code !== 0 && !outcome.timedOut) {
          ctx.emit({ type: "codex.exit", level: "warn", data: { code: outcome.code, signal: outcome.signal } });
        }
      })
      .catch(() => {});

    // Initialize handshake.
    const initTimeout = setTimeout(() => {
      child.killTree().catch(() => {});
    }, INIT_TIMEOUT_MS);
    try {
      await rpc.request(
        "initialize",
        { clientInfo: { name: "codex-cursor-bridge", title: "codex-cursor-bridge", version: "0.1.0" } },
        INIT_TIMEOUT_MS,
      );
      rpc.notify("initialized");
    } finally {
      clearTimeout(initTimeout);
    }

    return {
      rpc,
      threads,
      waitExit,
      shutdown: () => {
        rpc.close();
        child.killTree().catch(() => {});
      },
      lastAgentMessage: () => lastAgentMessage,
      items: () => items,
      usages: () => usages,
      turnErrors: () => turnErrors,
    };
  }

  async run(request: StartRequest, ctx: AdapterRunContext): Promise<JobResult> {
    const startedAt = new Date().toISOString();
    const sandbox = mapProfileToSandbox(request.permissionProfile, ctx.cwd, ctx.networkPolicy);
    const conn = await this.connect(ctx);
    const warnings: string[] = [];

    try {
      const startParams: Record<string, unknown> = {
        cwd: ctx.cwd,
        sandbox: sandbox.sandboxMode,
        approvalPolicy: "never",
        // Turn-level overrides below also carry the network policy.
      };
      if (request.model) startParams.model = request.model;

      const startRes = (await conn.rpc.request("thread/start", startParams, TURN_START_TIMEOUT_MS)) as {
        thread?: { id?: string; sessionId?: string };
      };
      const threadId = startRes?.thread?.id;
      if (!threadId) {
        throw new BridgeError("ADAPTER_PROTOCOL_ERROR", "thread/start returned no thread.id");
      }
      ctx.onNativeId(threadId);

      const turnParams: Record<string, unknown> = {
        threadId,
        input: [{ type: "text", text: buildTaskPrompt(request, "codex") }],
        sandboxPolicy: sandbox.turnSandboxPolicy,
      };
      if (request.model) turnParams.model = request.model;
      if (request.reasoningEffort) turnParams.effort = request.reasoningEffort;

      const turnPromise = conn.rpc.request("turn/start", turnParams, 0);

      // Race: turn completion vs abort vs process exit.
      const abortPromise = new Promise<never>((_, reject) => {
        if (ctx.abortSignal.aborted) reject(new BridgeError("JOB_CANCELLED", "job aborted"));
        else ctx.abortSignal.addEventListener("abort", () => reject(new BridgeError("JOB_CANCELLED", "job aborted")), { once: true });
      });
      const exitPromise = conn.waitExit.then(() => {
        throw new BridgeError("CHILD_EXITED", "codex app-server exited before the turn completed");
      });

      let turnResult: unknown;
      try {
        turnResult = await Promise.race([turnPromise, abortPromise, exitPromise]);
      } catch (err) {
        const be = err as { code?: string };
        if (be.code === "JOB_CANCELLED" || be.code === "CHILD_EXITED" || be.code === "ADAPTER_TIMEOUT") {
          // Interrupt the running turn, but do not block on the reply: the
          // transport may already be closing during cancellation.
          const t = conn.threads.get(threadId);
          if (t?.turnId) {
            void conn.rpc
              .request("turn/interrupt", { threadId, turnId: t.turnId }, 2_000)
              .catch(() => {});
          }
          conn.shutdown();
          throw err;
        }
        throw err;
      }
      void turnResult;

      const finishedAt = new Date().toISOString();
      const summaryText = conn.lastAgentMessage() ?? "(codex returned no final message)";
      const allItems = conn.items();
      const changed = extractChangedFiles(allItems);
      const commands = extractCommands(allItems);
      const continuationSupported = true;

      const result: JobResult = {
        jobId: ctx.jobId,
        nativeId: threadId,
        adapter: this.name,
        status: "completed",
        summary: summaryText.slice(0, 10_000),
        findings: [],
        commands,
        warnings,
        artifacts: [],
        continuation: {
          supported: continuationSupported,
          how: `codex_reply with nativeId=${threadId} (thread/resume on the same app-server)`,
        },
        startedAt,
        finishedAt,
        failure: null,
      };
      if (changed.length > 0) {
        result.changedFiles = changed;
      }
      const lastUsage = conn.usages().at(-1) as { total?: Record<string, number> } | undefined;
      if (lastUsage?.total) {
        result.findings = [
          `token usage: ${JSON.stringify(lastUsage.total)}`,
        ];
      }
      return result;
    } finally {
      conn.shutdown();
    }
  }

  /** Continue an existing Codex thread with a follow-up message. */
  async reply(nativeId: string, message: string, ctx: AdapterRunContext): Promise<JobResult> {
    const startedAt = new Date().toISOString();
    const conn = await this.connect(ctx);
    try {
      // Resume by id (works whether or not the thread is still loaded).
      await conn.rpc.request("thread/resume", { threadId: nativeId }, TURN_START_TIMEOUT_MS);
      const turnParams: Record<string, unknown> = {
        threadId: nativeId,
        input: [{ type: "text", text: message }],
      };
      await conn.rpc.request("turn/start", turnParams, 0);
      const abortPromise = new Promise<never>((_, reject) => {
        if (ctx.abortSignal.aborted) reject(new BridgeError("JOB_CANCELLED", "job aborted"));
        else ctx.abortSignal.addEventListener("abort", () => reject(new BridgeError("JOB_CANCELLED", "job aborted")), { once: true });
      });
      const exitPromise = conn.waitExit.then(() => {
        throw new BridgeError("CHILD_EXITED", "codex app-server exited before the follow-up completed");
      });
      await Promise.race([abortPromise, exitPromise]).catch((err) => {
        conn.shutdown();
        throw err;
      });
      const summaryText = conn.lastAgentMessage() ?? "(codex returned no final message)";
      const finishedAt = new Date().toISOString();
      return {
        jobId: ctx.jobId,
        nativeId,
        adapter: this.name,
        status: "completed",
        summary: summaryText.slice(0, 10_000),
        continuation: { supported: true, how: `codex_reply with nativeId=${nativeId}` },
        startedAt,
        finishedAt,
        failure: null,
      };
    } finally {
      conn.shutdown();
    }
  }
}

function summarizeItem(item: Record<string, unknown>): Record<string, unknown> {
  const type = item.type;
  if (type === "commandExecution") {
    return {
      type,
      command: item.command,
      exitCode: item.exitCode,
      aggregatedOutput: typeof item.aggregatedOutput === "string" ? redactString(item.aggregatedOutput.slice(0, 4000)) : undefined,
    };
  }
  if (type === "fileChange") {
    return { type, changes: item.changes };
  }
  if (type === "agentMessage") {
    const text = typeof item.text === "string" ? item.text : "";
    return { type, textPreview: text.slice(0, 500) };
  }
  if (type === "error") {
    return { type, message: item.message };
  }
  return { type, id: item.id };
}

/** Create a scratch dir used by exec fallback for prompt files. */
export async function makePromptScratchDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "ccb-codex-"));
}
void makePromptScratchDir;
