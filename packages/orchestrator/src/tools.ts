/**
 * Shared MCP tool router: one definition set per host direction.
 *
 * Cursor-facing tools expose ONLY Codex operations; Codex-facing tools
 * expose ONLY Cursor operations. Strict JSON-schema inputs/outputs; no
 * shell-command tool exists.
 */

import {
  BridgeError,
  asBridgeError,
  redactString,
  validateStartRequest,
  type StartRequest,
} from "@codex-cursor-bridge/bridge-core";
import { JobManager } from "./job-manager.js";

export interface ToolResult {
  /** Structured machine-readable payload (returned as JSON to the host). */
  payload: unknown;
  /** Concise human-readable summary appended to tool output. */
  summary: string;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

const startSchemaProperties = {
  task: { type: "string", minLength: 1, description: "The delegated task. State the problem, constraints, and expected deliverable precisely." },
  cwd: { type: "string", minLength: 1, description: "Absolute path to the repository/working directory the agent should operate in." },
  mode: {
    type: "string",
    enum: ["investigate", "review", "adversarial-review", "rescue", "plan", "implement"],
    description: "Delegation mode. investigate/review/adversarial-review/plan run read-only; implement requires a write profile.",
  },
  permissionProfile: {
    type: "string",
    enum: ["read-only", "isolated-workspace-write", "current-workspace-write"],
    description: "Write policy. read-only (default): agent cannot modify files. isolated-workspace-write: changes happen in a temporary git worktree. current-workspace-write: agent edits your current working tree (use sparingly).",
  },
  background: { type: "boolean", description: "Start as a background job and return the job id immediately." },
  model: { type: "string", description: "Optional model override. Omit to use the host's configured default." },
  reasoningEffort: { type: "string", enum: ["low", "medium", "high", "xhigh"], description: "Optional reasoning effort when supported." },
  baseRef: { type: "string", description: "Git base reference for worktree creation." },
  timeoutMs: { type: "integer", description: "Job timeout in milliseconds." },
  constraints: { type: "array", items: { type: "string" }, description: "Constraints the delegated agent must respect." },
  expectedOutput: { type: "string", description: "Description of the expected deliverable." },
  origin: {
    type: "object",
    description: "Recursion metadata (filled by the delegating host).",
    properties: {
      host: { type: "string", enum: ["cursor", "codex", "cli"] },
      requestId: { type: "string" },
      parentJobId: { type: "string" },
      handoffDepth: { type: "integer", minimum: 0, maximum: 2 },
      maxHandoffDepth: { type: "integer", minimum: 0, maximum: 2 },
    },
  },
} as const;

function statusPayload(record: ReturnType<JobManager["get"]>): Record<string, unknown> {
  return {
    jobId: record.jobId,
    status: record.status,
    adapter: record.adapter,
    nativeId: record.nativeId ?? null,
    mode: record.mode,
    permissionProfile: record.permissionProfile,
    handoffDepth: record.handoffDepth,
    createdAt: record.createdAt,
    startedAt: record.startedAt ?? null,
    finishedAt: record.finishedAt ?? null,
    deadlineAt: record.deadlineAt ?? null,
    worktree: record.worktree ? { path: record.worktree.path, branch: record.worktree.branch, baseRef: record.worktree.baseRef } : null,
    events: record.events.slice(-12).map((e: { ts: string; type: string }) => ({ ts: e.ts, type: e.type })),
    hasResult: record.result != null,
  };
}

function resultPayload(record: ReturnType<JobManager["get"]>): Record<string, unknown> {
  const r = record.result;
  if (!r) {
    return {
      jobId: record.jobId,
      status: record.status,
      nativeId: record.nativeId ?? null,
      result: null,
      note: record.status === "running" ? "job still running; call status again later" : "no result recorded yet",
    };
  }
  return { jobId: record.jobId, status: record.status, nativeId: r.nativeId ?? record.nativeId ?? null, result: r };
}

export interface RouterOptions {
  originHost: "cursor" | "codex" | "cli";
  /** Tool name prefix for MCP (e.g. codex_ or cursor_). */
  prefix: "codex" | "cursor";
  manager: JobManager;
  /** For diagnostics surfaced through list/doctor tools. */
  describeAvailability?: () => Promise<string>;
}

export function buildToolRouter(opts: RouterOptions): ToolDef[] {
  const target = opts.prefix;
  const manager = opts.manager;

  const makeStart = (): ToolDef => ({
    name: `${target}_start`,
    description:
      target === "codex"
        ? "Start a Codex job (investigate / review / adversarial-review / rescue / plan / implement) with sandboxing, background job management, and a persistent Codex thread id."
        : "Start a Cursor agent job (investigate / review / adversarial-review / rescue / plan / implement) with permission profiles, background job management, and a persistent Cursor session id.",
    inputSchema: { type: "object", properties: { ...startSchemaProperties }, required: ["task", "cwd"], additionalProperties: false },
    handler: async (args) => {
      const vr = validateStartRequest(args);
      if (!vr.ok) {
        throw new BridgeError("BRIDGE_USAGE", `invalid ${target}_start arguments: ${vr.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`, {
          details: vr.issues,
        });
      }
      const request = vr.value as StartRequest;
      const enq = await manager.enqueue(request, {
        host: opts.originHost,
        tool: `${target}_start`,
        client: "mcp",
      });
      const result = await manager.run(enq.jobId);
      return {
        payload: { jobId: result.jobId, nativeId: result.nativeId, status: result.status, result },
        summary: `${target} job ${result.jobId} finished with status ${result.status}${result.nativeId ? ` (native id ${result.nativeId})` : ""}. ${redactString(result.summary.slice(0, 400))}`,
      };
    },
  });

  const makeStatus = (): ToolDef => ({
    name: `${target}_status`,
    description: `Get the current status of a ${target} bridge job (state machine position, adapter, native session id, recent events).`,
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string", description: "Bridge job id (job_...) returned by start." } },
      required: ["jobId"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const jobId = String(args.jobId ?? "");
      const record = manager.get(jobId);
      const payload = statusPayload(record);
      return { payload, summary: `job ${jobId}: ${record.status}${record.nativeId ? ` (native ${record.nativeId})` : ""}` };
    },
  });

  const makeResult = (): ToolDef => ({
    name: `${target}_result`,
    description: `Retrieve the final result of a ${target} bridge job (summary, findings, changed files, diff stats, tests, warnings, continuation info).`,
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "Bridge job id (job_...)." },
        wait: { type: "boolean", description: "Not supported: results are only available once the job finishes. Use status to poll." },
      },
      required: ["jobId"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const jobId = String(args.jobId ?? "");
      const record = manager.get(jobId);
      const payload = resultPayload(record);
      const r = record.result;
      return {
        payload,
        summary: r
          ? `${target} job ${jobId} ${r.status}: ${redactString(r.summary.slice(0, 400))}`
          : `job ${jobId} has no result yet (status ${record.status})`,
      };
    },
  });

  const makeReply = (): ToolDef => ({
    name: `${target}_reply`,
    description: `Send a follow-up message to the SAME native ${target} session/thread of an existing job (continuation when supported).`,
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "Bridge job id to follow up on." },
        message: { type: "string", description: "Follow-up message for the native session." },
      },
      required: ["jobId", "message"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const jobId = String(args.jobId ?? "");
      const message = String(args.message ?? "");
      if (message.trim().length === 0) throw new BridgeError("BRIDGE_USAGE", "message must be non-empty");
      const record = manager.get(jobId);
      if (!record.nativeId) {
        return { payload: { jobId, accepted: false }, summary: `job ${jobId} has no native session id; cannot follow up` };
      }
      const res = await manager.reply(jobId, message);
      return {
        payload: { jobId, nativeId: record.nativeId, accepted: res.accepted, note: res.note },
        summary: res.accepted
          ? `follow-up queued for ${target} session ${record.nativeId}; run a follow-up job via the CLI to receive the answer`
          : `follow-up not accepted: ${res.note ?? "unsupported"}`,
      };
    },
  });

  const makeCancel = (): ToolDef => ({
    name: `${target}_cancel`,
    description: `Cancel a running ${target} bridge job. Terminates the child agent process tree and records a cancelled result.`,
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const jobId = String(args.jobId ?? "");
      const result = await manager.cancel(jobId);
      return { payload: { jobId, status: result.status, nativeId: result.nativeId }, summary: `job ${jobId} cancelled` };
    },
  });

  const makeList = (): ToolDef => ({
    name: `${target}_list`,
    description: `List recent ${target} bridge jobs with status and native session ids.`,
    inputSchema: { type: "object", properties: { limit: { type: "integer", description: "Max jobs to return (default 20)." } }, additionalProperties: false },
    handler: async (args) => {
      const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 100);
      const jobs = manager
        .list()
        .filter((j) => (opts.originHost === "cursor" ? j.targetHost === "codex" : j.targetHost === "cursor"))
        .slice(-limit)
        .reverse()
        .map((j) => ({
          jobId: j.jobId,
          status: j.status,
          mode: j.mode,
          adapter: j.adapter,
          nativeId: j.nativeId ?? null,
          createdAt: j.createdAt,
          taskPreview: redactString(j.task.slice(0, 120)),
        }));
      return { payload: { jobs }, summary: `${jobs.length} job(s)` };
    },
  });

  return [makeStart(), makeStatus(), makeResult(), makeReply(), makeCancel(), makeList()];
}

/** Wrap a tool handler into safe MCP responses (never throws into the transport). */
export async function invokeToolSafe(
  tool: ToolDef,
  args: Record<string, unknown>,
): Promise<{ ok: true; payload: unknown; summary: string } | { ok: false; code: string; message: string }> {
  try {
    const res = await tool.handler(args);
    return { ok: true, payload: res.payload, summary: res.summary };
  } catch (err) {
    const be = asBridgeError(err);
    return { ok: false, code: be.code, message: redactString(be.message) };
  }
}
