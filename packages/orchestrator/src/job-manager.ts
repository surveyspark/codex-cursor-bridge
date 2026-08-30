/**
 * Job manager: the heart of the bridge.
 *
 * Responsibilities:
 * - Validate start requests (mode, profile, recursion depth).
 * - Apply permission-profile rules (read-only default; worktree isolation
 *   for implementation by default; current-tree writes only when explicit).
 * - Run jobs through the selected adapter with events persisted to JobStore.
 * - Enforce timeouts, concurrency limits, and cancellation (process trees).
 * - Collect results, diffs, and artifacts; keep native session ids.
 */

import {
  BridgeError,
  asBridgeError,
  canonicalize,
  DEFAULT_CONFIG,
  type BridgeConfig,
  type JobRecord,
  type JobResult,
  type Logger,
  type StartRequest,
} from "@codex-cursor-bridge/bridge-core";
import { JobStore, newJobId } from "@codex-cursor-bridge/job-store";
import type { AgentAdapter, AdapterRunContext } from "@codex-cursor-bridge/codex-adapter";
import { defaultWorktreeRoot, jobsDir, loadConfig, logsDir } from "./config-resolve.js";
import {
  collectCurrentDiffSummary,
  collectWorktreeDiff,
  createWorktree,
  inspectGit,
} from "./worktree.js";

export interface JobManagerOptions {
  config?: Partial<BridgeConfig>;
  repoRoot: string;
  logger?: Logger;
  /** Adapter selection is injected so CLI/MCP servers share one code path. */
  selectAdapter: (request: StartRequest, record: JobRecord) => Promise<{ adapter: AgentAdapter; reason: string }>;
}

export interface StartJobOptions {
  /** Start and run to completion in this process (MCP tools wait). */
  wait?: boolean;
  onEvent?: (jobId: string, event: { type: string; data?: unknown }) => void;
}

export interface StartJobResult {
  jobId: string;
  status: JobRecord["status"];
  nativeId?: string | null;
  result?: JobResult;
  record: JobRecord;
}

const HARD_MAX_HANDOFF_DEPTH = 2;

export class JobManager {
  readonly store: JobStore;
  readonly config: BridgeConfig;
  private readonly repoRoot: string;
  private readonly selectAdapter: JobManagerOptions["selectAdapter"];
  private running = 0;
  private readonly queue: Array<() => void> = [];
  private readonly aborts = new Map<string, AbortController>();

  constructor(opts: JobManagerOptions) {
    const loaded = loadConfig(opts.repoRoot, opts.config);
    this.config = loaded.config;
    void opts.logger;
    this.repoRoot = canonicalize(opts.repoRoot);
    this.store = new JobStore({ jobsDir: jobsDir() });
    this.selectAdapter = opts.selectAdapter;
  }

  private gate(): Promise<void> {
    if (this.running < this.config.maxConcurrency) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  private release(): void {
    this.running = Math.max(0, this.running - 1);
    const next = this.queue.shift();
    if (next) next();
  }

  /** Validate + create the job record (queued). */
  async enqueue(
    request: StartRequest,
    origin: { host: JobRecord["originHost"]; tool?: string; client?: string },
  ): Promise<StartJobResult> {
    const requestNorm: StartRequest = {
      ...request,
      cwd: canonicalize(request.cwd),
      mode: request.mode ?? "investigate",
      permissionProfile: request.permissionProfile ?? this.profileForMode(request.mode ?? "investigate"),
      background: request.background ?? true,
      origin: {
        host: origin.host,
        requestId: request.origin?.requestId,
        parentJobId: request.origin?.parentJobId,
        handoffDepth: request.origin?.handoffDepth ?? 0,
        maxHandoffDepth: request.origin?.maxHandoffDepth ?? this.config.maxHandoffDepth,
      },
    };

    // Recursion control.
    const depth = requestNorm.origin!.handoffDepth;
    const maxDepth = Math.min(requestNorm.origin!.maxHandoffDepth, HARD_MAX_HANDOFF_DEPTH);
    if (depth > maxDepth) {
      throw new BridgeError(
        "RECURSION_BLOCKED",
        `delegation depth ${depth} exceeds maximum ${maxDepth}; nested ${origin.host} -> ${this.targetOf(origin.host)} delegation is blocked`,
      );
    }
    if (origin.host !== "cli" && this.targetOf(origin.host) === undefined) {
      throw new BridgeError("BRIDGE_USAGE", `unknown origin host ${origin.host}`);
    }

    const git = await inspectGit(requestNorm.cwd);
    const jobId = newJobId();
    const timeoutMs = request.timeoutMs ?? this.config.defaultTimeoutMs;

    const record = this.store.create({
      jobId,
      parentJobId: requestNorm.origin!.parentJobId ?? null,
      originHost: origin.host,
      targetHost: this.targetOf(origin.host),
      adapter: this.pendingAdapterName(origin.host),
      nativeId: null,
      mode: requestNorm.mode,
      permissionProfile: requestNorm.permissionProfile,
      handoffDepth: depth,
      maxHandoffDepth: maxDepth,
      origin: { requestId: requestNorm.origin!.requestId ?? null, tool: origin.tool ?? null, client: origin.client ?? null },
      repoRoot: this.repoRoot,
      cwd: requestNorm.cwd,
      worktree: null,
      task: requestNorm.task,
      status: "queued",
      exitCode: null,
      pid: null,
      pidHostBootId: null,
      startedAt: null,
      finishedAt: null,
      timeoutMs,
      deadlineAt: new Date(Date.now() + timeoutMs).toISOString(),
      retention: { deleteAfter: new Date(Date.now() + this.config.completedRetentionDays * 86_400_000).toISOString(), keepResult: true },
      followUps: [],
      approvals: [],
      ...(git.isGit ? {} : {}),
    });

    // Stash the normalized request for the runner (task field carries the prompt;
    // we persist the full request in events for transparency with redaction).
    this.store.appendEvent(jobId, {
      type: "job.enqueued",
      data: {
        mode: requestNorm.mode,
        permissionProfile: requestNorm.permissionProfile,
        background: requestNorm.background,
        handoffDepth: depth,
        maxHandoffDepth: maxDepth,
        originHost: origin.host,
        git: { isGit: git.isGit, hasCommits: git.hasCommits, dirty: git.dirty, branch: git.branch },
      },
    });

    return { jobId, status: record.status, nativeId: null, record };
  }

  /**
   * Execute an enqueued job. When `wait` is false the runner detaches:
   * the CLI runner child process records its pid in the job record, and
   * `codex-cursor-bridge codex status/result` can poll it later. In this
   * bundled design, MCP tools and the CLI both use wait=true by default and
   * the background contract is preserved by job records surviving the run.
   */
  async run(jobId: string, _opts: { onEvent?: (e: { type: string; data?: unknown }) => void } = {}): Promise<JobResult> {
    const record = this.store.get(jobId);
    if (record.status !== "queued") {
      throw new BridgeError("JOB_INVALID_TRANSITION", `job ${jobId} is ${record.status}, expected queued`);
    }
    const git = await inspectGit(record.cwd);
    await this.gate();
    const abort = new AbortController();
    this.aborts.set(jobId, abort);
    const timeout = setTimeout(() => abort.abort(new Error("timeout")), record.timeoutMs ?? this.config.defaultTimeoutMs);

    try {
      this.store.update(jobId, (r) => {
        r.status = "starting";
        r.startedAt = new Date().toISOString();
      });

      const request = this.requestFromRecord(record);
      const { adapter, reason } = await this.selectAdapter(request, record);
      this.store.update(jobId, (r) => {
        r.adapter = adapter.name;
      });
      this.store.appendEvent(jobId, { type: "adapter.selected", data: { adapter: adapter.name, reason } });

      // Worktree isolation for writes.
      let cwd = record.cwd;
      if (request.permissionProfile === "isolated-workspace-write") {
        const wt = await createWorktree({
          repoRoot: this.repoRoot,
          worktreeRoot: this.config.worktreeRoot ?? defaultWorktreeRoot(),
          jobId,
          baseRef: request.baseRef,
        });
        cwd = wt.path;
        this.store.update(jobId, (r) => {
          r.worktree = wt;
        });
        this.store.appendEvent(jobId, { type: "worktree.created", data: { path: wt.path, branch: wt.branch, baseRef: wt.baseRef } });
      } else if (request.permissionProfile === "current-workspace-write" && git.dirty) {
        this.store.appendEvent(jobId, {
          type: "worktree.skipped",
          level: "warn",
          data: { note: "current-workspace-write explicitly selected; the developer's dirty working tree will be modified in place" },
        });
      }

      this.store.update(jobId, (r) => {
        r.status = "running";
        r.cwd = cwd;
      });

      const ctx: AdapterRunContext = {
        jobId,
        cwd,
        abortSignal: abort.signal,
        debugLogging: this.config.debugLogging,
        networkPolicy: this.config.networkPolicy,
        maxOutputBytes: this.config.maxOutputBytes,
        emit: (event) => {
          this.store.appendEvent(jobId, event);
        },
        approval: (approval) => {
          this.store.update(jobId, (r) => {
            r.approvals = [...(r.approvals ?? []), approval].slice(-500);
          });
        },
        onNativeId: (nativeId) => {
          this.store.update(jobId, (r) => {
            r.nativeId = nativeId;
          });
        },
      };

      const result = await adapter.run(request, ctx);
      return await this.finalize(jobId, result, record.cwd);
    } catch (err) {
      const be = asBridgeError(err);
      const status =
        be.code === "JOB_CANCELLED" ? "cancelled" : be.code === "JOB_TIMEOUT" || abort.signal.aborted ? "timed-out" : "failed";
      const result: JobResult = {
        jobId,
        nativeId: this.store.tryGet(jobId)?.nativeId ?? null,
        adapter: this.store.tryGet(jobId)?.adapter ?? "codex-app-server",
        status,
        summary:
          status === "cancelled"
            ? "job was cancelled by request."
            : status === "timed-out"
              ? `job exceeded its ${record.timeoutMs ?? this.config.defaultTimeoutMs}ms timeout and was terminated.`
              : `job failed: ${be.message}`,
        continuation: { supported: false, how: "see job events for progress before the failure" },
        startedAt: record.startedAt ?? null,
        finishedAt: new Date().toISOString(),
        failure: { code: be.code, message: be.message, retriable: be.retriable },
      };
      return await this.finalize(jobId, result, record.cwd);
    } finally {
      clearTimeout(timeout);
      this.aborts.delete(jobId);
      this.release();
    }
  }

  /** Record final status, collect diffs/artifacts, persist the result. */
  private async finalize(jobId: string, result: JobResult, originalCwd: string): Promise<JobResult> {
    const record = this.store.get(jobId);
    // Diff collection for write modes.
    if (result.status === "completed" && record.permissionProfile !== "read-only") {
      try {
        if (record.worktree) {
          const summary = await collectWorktreeDiff(
            { ...record.worktree, created: true },
            originalCwd,
            this.config.maxOutputBytes,
          );
          result.diffStat = { filesChanged: summary.filesChanged, insertions: summary.insertions, deletions: summary.deletions };
          result.changedFiles = summary.files;
          result.diffPatchPath = summary.patchPath;
          if (summary.patchPath) {
            result.artifacts = [...(result.artifacts ?? []), { path: summary.patchPath, kind: "patch" }];
          }
        } else {
          const summary = await collectCurrentDiffSummary(originalCwd, null, this.config.maxOutputBytes);
          result.diffStat = { filesChanged: summary.filesChanged, insertions: summary.insertions, deletions: summary.deletions };
          result.changedFiles = summary.files;
        }
      } catch (err) {
        result.warnings = [...(result.warnings ?? []), `diff collection failed: ${asBridgeError(err).message}`];
      }
    }
    if (result.status === "completed" && record.permissionProfile === "read-only" && (result.changedFiles?.length ?? 0) > 0) {
      result.warnings = [
        ...(result.warnings ?? []),
        "read-only job reported changed files; verify unexpected modifications before continuing",
      ];
    }

    this.store.update(jobId, (r) => {
      r.status = result.status;
      r.finishedAt = result.finishedAt ?? new Date().toISOString();
      r.result = result;
      r.nativeId = result.nativeId ?? r.nativeId ?? null;
    });
    this.store.appendEvent(jobId, { type: `job.${result.status}` });
    return result;
  }

  /** Cancel a job: abort its controller (kills the child process tree) and record the outcome. */
  async cancel(jobId: string, reason = "cancelled by user"): Promise<JobResult> {
    const record = this.store.get(jobId);
    if (["completed", "failed", "cancelled", "timed-out"].includes(record.status)) {
      throw new BridgeError("JOB_ALREADY_TERMINAL", `job ${jobId} already finished as ${record.status}`);
    }
    const abort = this.aborts.get(jobId);
    if (abort) {
      abort.abort(new Error(reason));
    } else {
      // Not running in this process: mark cancelled anyway (queued/stale).
      this.store.update(jobId, (r) => {
        r.status = "cancelled";
        r.finishedAt = new Date().toISOString();
      });
      this.store.appendEvent(jobId, { type: "job.cancelled", level: "warn", data: { reason } });
    }
    const result: JobResult = {
      jobId,
      nativeId: this.store.tryGet(jobId)?.nativeId ?? null,
      adapter: record.adapter,
      status: "cancelled",
      summary: `job cancelled: ${reason}`,
      continuation: {
        supported: (this.store.tryGet(jobId)?.nativeId ?? null) != null,
        how: this.store.tryGet(jobId)?.nativeId
          ? `native session ${this.store.tryGet(jobId)!.nativeId} may be resumable (see result continuation)`
          : "no native session id",
      },
      startedAt: record.startedAt ?? null,
      finishedAt: new Date().toISOString(),
      failure: { code: "JOB_CANCELLED", message: reason, retriable: false },
    };
    if (!this.store.tryGet(jobId)?.result) {
      this.store.update(jobId, (r) => {
        r.result = result;
      });
    }
    return result;
  }

  /** Append a follow-up message; returns false when the adapter can't continue. */
  async reply(jobId: string, message: string): Promise<{ accepted: boolean; note?: string }> {
    const record = this.store.get(jobId);
    if (!record.nativeId) {
      this.store.update(jobId, (r) => {
        r.followUps = [
          ...(r.followUps ?? []),
          { ts: new Date().toISOString(), message, accepted: false, note: "no native session id; follow-up impossible" },
        ];
      });
      return { accepted: false, note: "job has no native session id to continue" };
    }
    this.store.update(jobId, (r) => {
      r.followUps = [...(r.followUps ?? []), { ts: new Date().toISOString(), message, accepted: undefined }];
    });
    this.store.appendEvent(jobId, { type: "followup.requested", data: { nativeId: record.nativeId } });
    return { accepted: true };
  }

  get(jobId: string): JobRecord {
    return this.store.get(jobId);
  }

  list(): JobRecord[] {
    return this.store.list();
  }

  clean(opts?: { dryRun?: boolean }): { removed: string[]; completedRetentionDays: number; failedRetentionDays: number } {
    return {
      removed: this.store.clean({
        completedRetentionDays: this.config.completedRetentionDays,
        failedRetentionDays: this.config.jobRetentionDays,
        ...(opts?.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
      }),
      completedRetentionDays: this.config.completedRetentionDays,
      failedRetentionDays: this.config.jobRetentionDays,
    };
  }

  /** Recover crashed jobs (called by CLI/MCP at startup). */
  recover(): string[] {
    return this.store.recover();
  }

  private targetOf(host: JobRecord["originHost"]): JobRecord["targetHost"] {
    return host === "cursor" ? "codex" : host === "codex" ? "cursor" : "codex";
  }

  private profileForMode(mode: StartRequest["mode"]): StartRequest["permissionProfile"] {
    if (mode === "implement") return this.config.defaultImplementProfile;
    return this.config.defaultPermissionProfile;
  }

  private pendingAdapterName(originHost: JobRecord["originHost"]): JobRecord["adapter"] {
    return originHost === "codex" ? "cursor-sdk" : "codex-app-server";
  }

  private requestFromRecord(record: JobRecord): StartRequest {
    return {
      task: record.task,
      cwd: record.cwd,
      mode: record.mode,
      permissionProfile: record.permissionProfile,
      background: false,
      origin: {
        host: record.originHost,
        handoffDepth: record.handoffDepth,
        maxHandoffDepth: record.maxHandoffDepth,
        parentJobId: record.parentJobId ?? undefined,
      },
    };
  }
}

export { DEFAULT_CONFIG, jobsDir, logsDir, defaultWorktreeRoot, loadConfig };
export type { Logger };
