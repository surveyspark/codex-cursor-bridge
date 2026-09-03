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
  assertInsideRepo,
  assertNoSymlinkEscape,
  canonicalize,
  currentBootId,
  DEFAULT_CONFIG,
  isPidAlive,
  killPidTree,
  TERMINAL_JOB_STATUSES,
  type BridgeConfig,
  type JobRecord,
  type JobResult,
  type Logger,
  type StartRequest,
  type TargetHost,
} from "@codex-cursor-bridge/bridge-core";
import {
  JobStore,
  assertTransition,
  newJobId,
} from "@codex-cursor-bridge/job-store";
import {
  buildFollowUpPrompt,
  type AgentAdapter,
  type AdapterRunContext,
} from "@codex-cursor-bridge/codex-adapter";
import {
  defaultWorktreeRoot,
  jobsDir,
  loadConfig,
  logsDir,
} from "./config-resolve.js";
import {
  collectCurrentDiffSummary,
  collectWorktreeDiff,
  createWorktree,
  inspectGit,
  removeWorktree,
} from "./worktree.js";

export interface JobManagerOptions {
  config?: Partial<BridgeConfig>;
  repoRoot: string;
  logger?: Logger;
  /** Adapter selection is injected so CLI/MCP servers share one code path. */
  selectAdapter: (
    request: StartRequest,
    record: JobRecord,
  ) => Promise<{ adapter: AgentAdapter; reason: string }>;
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
  private readonly cancelReasons = new Map<string, string>();
  /** Request metadata not representable in schema v1.0 job records
   *  (constraints/expectedOutput/model/effort/baseRef). Process-local by
   *  design: MCP tools run jobs synchronously; CLI start waits. */
  private readonly requestMeta = new Map<
    string,
    Pick<
      StartRequest,
      "constraints" | "expectedOutput" | "model" | "reasoningEffort" | "baseRef"
    >
  >();

  constructor(opts: JobManagerOptions) {
    const loaded = loadConfig(opts.repoRoot, opts.config);
    this.config = loaded.config;
    if (opts.logger) {
      for (const warning of loaded.warnings) opts.logger.warn(warning);
    }
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
    origin: {
      host: JobRecord["originHost"];
      tool?: string;
      client?: string;
      targetHost?: TargetHost;
    },
  ): Promise<StartJobResult> {
    const cwd = assertNoSymlinkEscape(
      this.repoRoot,
      assertInsideRepo(this.repoRoot, request.cwd, "cwd"),
    );
    const mode = request.mode ?? "investigate";
    const permissionProfile =
      request.permissionProfile ?? this.profileForMode(mode);
    this.assertModeProfile(mode, permissionProfile);

    const parentJobId =
      request.origin?.parentJobId ?? process.env.CCB_PARENT_JOB_ID ?? undefined;
    const parent = parentJobId ? this.store.tryGet(parentJobId) : null;
    const derivedDepth = parent ? parent.handoffDepth + 1 : 0;
    const envFloor = Number.parseInt(process.env.CCB_HANDOFF_DEPTH ?? "", 10);
    const claimed = request.origin?.handoffDepth ?? 0;
    const depth = Math.max(
      derivedDepth,
      Number.isFinite(envFloor) ? envFloor : 0,
      claimed,
    );
    const maxDepth = Math.min(
      this.config.maxHandoffDepth,
      HARD_MAX_HANDOFF_DEPTH,
    );

    const requestNorm: StartRequest = {
      ...request,
      cwd,
      mode,
      permissionProfile,
      background: request.background ?? true,
      origin: {
        host: origin.host,
        ...(request.origin?.requestId
          ? { requestId: request.origin.requestId }
          : {}),
        ...(parentJobId ? { parentJobId } : {}),
        handoffDepth: depth,
        maxHandoffDepth: maxDepth,
      },
    };

    // Recursion control.
    const targetHost = this.resolveTarget(origin);
    if (depth > maxDepth) {
      throw new BridgeError(
        "RECURSION_BLOCKED",
        `delegation depth ${depth} exceeds maximum ${maxDepth}; nested ${origin.host} -> ${targetHost} delegation is blocked`,
      );
    }

    const git = await inspectGit(requestNorm.cwd);
    const jobId = newJobId();
    const timeoutMs = request.timeoutMs ?? this.config.defaultTimeoutMs;

    const record = this.store.create({
      jobId,
      parentJobId: requestNorm.origin!.parentJobId ?? null,
      originHost: origin.host,
      targetHost,
      adapter: this.pendingAdapterName(targetHost),
      nativeId: null,
      mode: requestNorm.mode,
      permissionProfile: requestNorm.permissionProfile,
      handoffDepth: depth,
      maxHandoffDepth: maxDepth,
      origin: {
        requestId: requestNorm.origin!.requestId ?? null,
        tool: origin.tool ?? null,
        client: origin.client ?? null,
      },
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
      retention: {
        deleteAfter: new Date(
          Date.now() + this.config.completedRetentionDays * 86_400_000,
        ).toISOString(),
        keepResult: true,
      },
      followUps: [],
      approvals: [],
      ...(git.isGit ? {} : {}),
    });

    // Stash request metadata for the runner (job record keeps the prompt only).
    this.requestMeta.set(jobId, {
      ...(requestNorm.constraints
        ? { constraints: requestNorm.constraints }
        : {}),
      ...(requestNorm.expectedOutput
        ? { expectedOutput: requestNorm.expectedOutput }
        : {}),
      ...(requestNorm.model ? { model: requestNorm.model } : {}),
      ...(requestNorm.reasoningEffort
        ? { reasoningEffort: requestNorm.reasoningEffort }
        : {}),
      ...(requestNorm.baseRef ? { baseRef: requestNorm.baseRef } : {}),
    });
    this.store.appendEvent(jobId, {
      type: "job.enqueued",
      data: {
        mode: requestNorm.mode,
        permissionProfile: requestNorm.permissionProfile,
        background: requestNorm.background,
        handoffDepth: depth,
        maxHandoffDepth: maxDepth,
        originHost: origin.host,
        git: {
          isGit: git.isGit,
          hasCommits: git.hasCommits,
          dirty: git.dirty,
          branch: git.branch,
        },
      },
    });

    return { jobId, status: record.status, nativeId: null, record };
  }

  /**
   * Execute an enqueued job to completion and persist the result.
   * Callers that advertise background jobs (`*_start` with background true)
   * invoke this without awaiting so the tool can return the job id immediately.
   */
  async run(
    jobId: string,
    _opts: { onEvent?: (e: { type: string; data?: unknown }) => void } = {},
  ): Promise<JobResult> {
    const record = this.store.get(jobId);
    if (record.status !== "queued") {
      throw new BridgeError(
        "JOB_INVALID_TRANSITION",
        `job ${jobId} is ${record.status}, expected queued`,
      );
    }
    // Register the abort controller before any await so a cancel() racing
    // with startup still reaches the adapter.
    const abort = new AbortController();
    this.aborts.set(jobId, abort);
    if (abort.signal.aborted) {
      // cancel() already ran during startup: record and return.
      return await this.finalize(
        jobId,
        {
          jobId,
          nativeId: null,
          adapter: record.adapter,
          status: "cancelled",
          summary: "job cancelled before the agent started.",
          continuation: { supported: false, how: "job never started" },
          startedAt: null,
          finishedAt: new Date().toISOString(),
          failure: {
            code: "JOB_CANCELLED",
            message: "cancelled during startup",
            retriable: false,
          },
        },
        record.cwd,
      );
    }
    const git = await inspectGit(record.cwd);
    await this.gate();
    const timeout = setTimeout(
      () => abort.abort(new Error("timeout")),
      record.timeoutMs ?? this.config.defaultTimeoutMs,
    );

    try {
      this.store.update(jobId, (r) => {
        assertTransition(r.status, "starting");
        r.status = "starting";
        r.startedAt = new Date().toISOString();
      });

      const request = this.requestFromRecord(record);
      const { adapter, reason } = await this.selectAdapter(request, record);
      this.store.update(jobId, (r) => {
        r.adapter = adapter.name;
      });
      this.store.appendEvent(jobId, {
        type: "adapter.selected",
        data: { adapter: adapter.name, reason },
      });

      // Worktree isolation for writes, and for Cursor read-only jobs so
      // unenforced ACP/SDK writes cannot land on the developer's tree.
      let cwd = record.cwd;
      const isolate =
        request.permissionProfile === "isolated-workspace-write" ||
        (request.permissionProfile === "read-only" &&
          record.targetHost === "cursor");
      if (isolate) {
        const wt = await createWorktree({
          repoRoot: this.repoRoot,
          worktreeRoot: this.config.worktreeRoot ?? defaultWorktreeRoot(),
          jobId,
          ...(request.baseRef ? { baseRef: request.baseRef } : {}),
        });
        cwd = wt.path;
        this.store.update(jobId, (r) => {
          r.worktree = wt;
        });
        this.store.appendEvent(jobId, {
          type: "worktree.created",
          data: { path: wt.path, branch: wt.branch, baseRef: wt.baseRef },
        });
      } else if (
        request.permissionProfile === "current-workspace-write" &&
        git.dirty
      ) {
        this.store.appendEvent(jobId, {
          type: "worktree.skipped",
          level: "warn",
          data: {
            note: "current-workspace-write explicitly selected; the developer's dirty working tree will be modified in place",
          },
        });
      }

      this.store.update(jobId, (r) => {
        assertTransition(r.status, "running");
        r.status = "running";
        r.cwd = cwd;
        r.pid = process.pid;
        r.pidHostBootId = currentBootId();
      });

      const ctx: AdapterRunContext = {
        jobId,
        cwd,
        abortSignal: abort.signal,
        debugLogging: this.config.debugLogging,
        networkPolicy: this.config.networkPolicy,
        maxOutputBytes: this.config.maxOutputBytes,
        handoffEnv: {
          CCB_PARENT_JOB_ID: jobId,
          CCB_HANDOFF_DEPTH: String(this.store.get(jobId).handoffDepth),
        },
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
      const abortedExplicitly = this.cancelReasons.get(jobId) !== undefined;
      const status =
        be.code === "JOB_CANCELLED" || abortedExplicitly
          ? "cancelled"
          : be.code === "JOB_TIMEOUT" || abort.signal.aborted
            ? "timed-out"
            : "failed";
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
        continuation: {
          supported: false,
          how: "see job events for progress before the failure",
        },
        startedAt: record.startedAt ?? null,
        finishedAt: new Date().toISOString(),
        failure: {
          code: be.code,
          message: be.message,
          retriable: be.retriable,
        },
      };
      const finalized = await this.finalize(jobId, result, record.cwd);
      const rec = this.store.tryGet(jobId);
      if (
        rec?.worktree &&
        finalized.status !== "completed" &&
        (finalized.changedFiles?.length ?? 0) === 0
      ) {
        try {
          await removeWorktree(this.repoRoot, rec.worktree.path);
        } catch {
          /* best effort */
        }
      }
      return finalized;
    } finally {
      clearTimeout(timeout);
      this.aborts.delete(jobId);
      this.cancelReasons.delete(jobId);
      this.requestMeta.delete(jobId);
      this.release();
    }
  }

  /** Record final status, collect diffs/artifacts, persist the result. */
  private async finalize(
    jobId: string,
    result: JobResult,
    originalCwd: string,
  ): Promise<JobResult> {
    const record = this.store.get(jobId);
    if (TERMINAL_JOB_STATUSES.has(record.status) && record.result) {
      return record.result;
    }
    // Diff collection for write modes and for read-only jobs that used a
    // disposable worktree (Cursor) so a dirty tree cannot report completed.
    if (result.status === "completed") {
      try {
        if (record.worktree) {
          const summary = await collectWorktreeDiff(
            { ...record.worktree, created: true },
            originalCwd,
            this.config.maxOutputBytes,
          );
          result.diffStat = {
            filesChanged: summary.filesChanged,
            insertions: summary.insertions,
            deletions: summary.deletions,
          };
          result.changedFiles = summary.files;
          result.diffPatchPath = summary.patchPath;
          if (summary.patchPath) {
            result.artifacts = [
              ...(result.artifacts ?? []),
              { path: summary.patchPath, kind: "patch" },
            ];
          }
        } else if (record.permissionProfile !== "read-only") {
          const summary = await collectCurrentDiffSummary(
            originalCwd,
            null,
            this.config.maxOutputBytes,
          );
          result.diffStat = {
            filesChanged: summary.filesChanged,
            insertions: summary.insertions,
            deletions: summary.deletions,
          };
          result.changedFiles = summary.files;
        }
      } catch (err) {
        result.warnings = [
          ...(result.warnings ?? []),
          `diff collection failed: ${asBridgeError(err).message}`,
        ];
      }
    }
    if (
      result.status === "completed" &&
      record.permissionProfile === "read-only" &&
      (result.changedFiles?.length ?? 0) > 0
    ) {
      result.status = "failed";
      result.failure = {
        code: "PERMISSION_DENIED",
        message:
          "read-only job modified files; writes were isolated to a disposable worktree and the job is failed",
        retriable: false,
      };
      result.warnings = [
        ...(result.warnings ?? []),
        "read-only job reported changed files",
      ];
    }

    this.store.update(jobId, (r) => {
      if (TERMINAL_JOB_STATUSES.has(r.status) && r.result) return;
      assertTransition(r.status, result.status);
      r.status = result.status;
      r.finishedAt = result.finishedAt ?? new Date().toISOString();
      r.result = result;
      r.nativeId = result.nativeId ?? r.nativeId ?? null;
    });
    this.store.appendEvent(jobId, { type: `job.${result.status}` });
    return result;
  }

  /** Cancel a job: abort its controller (kills the child process tree) and record the outcome. */
  async cancel(
    jobId: string,
    reason = "cancelled by user",
  ): Promise<JobResult> {
    const record = this.store.get(jobId);
    if (
      ["completed", "failed", "cancelled", "timed-out"].includes(record.status)
    ) {
      throw new BridgeError(
        "JOB_ALREADY_TERMINAL",
        `job ${jobId} already finished as ${record.status}`,
      );
    }
    this.cancelReasons.set(jobId, reason);
    const abort = this.aborts.get(jobId);
    if (abort) {
      abort.abort(new Error(reason));
    } else if (record.status === "queued") {
      this.store.update(jobId, (r) => {
        if (TERMINAL_JOB_STATUSES.has(r.status)) return;
        assertTransition(r.status, "cancelled");
        r.status = "cancelled";
        r.finishedAt = new Date().toISOString();
      });
      this.store.appendEvent(jobId, {
        type: "job.cancelled",
        level: "warn",
        data: { reason },
      });
    } else if (
      record.pid &&
      record.pidHostBootId === currentBootId() &&
      isPidAlive(record.pid)
    ) {
      await killPidTree(record.pid);
      this.store.update(jobId, (r) => {
        if (TERMINAL_JOB_STATUSES.has(r.status)) return;
        assertTransition(r.status, "cancelled");
        r.status = "cancelled";
        r.finishedAt = new Date().toISOString();
      });
      this.store.appendEvent(jobId, {
        type: "job.cancelled",
        level: "warn",
        data: { reason, pid: record.pid },
      });
    } else {
      throw new BridgeError(
        "BRIDGE_NOT_SUPPORTED",
        `job ${jobId} is owned by another process and cannot be cancelled from here`,
      );
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

  /** Send a follow-up to the stored native session via the job's adapter. */
  async reply(
    jobId: string,
    message: string,
  ): Promise<{ accepted: boolean; note?: string; result?: JobResult }> {
    const record = this.store.get(jobId);
    if (!record.nativeId) {
      this.store.update(jobId, (r) => {
        r.followUps = [
          ...(r.followUps ?? []),
          {
            ts: new Date().toISOString(),
            message,
            accepted: false,
            note: "no native session id; follow-up impossible",
          },
        ];
      });
      return {
        accepted: false,
        note: "job has no native session id to continue",
      };
    }
    const request = this.requestFromRecord(record);
    const { adapter } = await this.selectAdapter(request, record);
    if (typeof adapter.reply !== "function") {
      this.store.update(jobId, (r) => {
        r.followUps = [
          ...(r.followUps ?? []),
          {
            ts: new Date().toISOString(),
            message,
            accepted: false,
            note: "adapter does not support continuation",
          },
        ];
      });
      return {
        accepted: false,
        note: "adapter does not support continuation",
      };
    }
    const abort = new AbortController();
    const timeoutMs = record.timeoutMs ?? this.config.defaultTimeoutMs;
    const timer = setTimeout(
      () => abort.abort(new Error("timeout")),
      timeoutMs,
    );
    const ctx: AdapterRunContext = {
      jobId,
      cwd: record.cwd,
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
    this.store.appendEvent(jobId, {
      type: "followup.requested",
      data: { nativeId: record.nativeId },
    });
    try {
      const result = await adapter.reply(
        record.nativeId,
        buildFollowUpPrompt(message),
        ctx,
      );
      this.store.update(jobId, (r) => {
        r.followUps = [
          ...(r.followUps ?? []),
          {
            ts: new Date().toISOString(),
            message,
            accepted: true,
          },
        ];
        r.result = result;
        r.nativeId = result.nativeId ?? r.nativeId ?? null;
      });
      this.store.appendEvent(jobId, {
        type: "followup.completed",
        data: { status: result.status, nativeId: result.nativeId },
      });
      return { accepted: true, result };
    } catch (err) {
      const be = asBridgeError(err);
      this.store.update(jobId, (r) => {
        r.followUps = [
          ...(r.followUps ?? []),
          {
            ts: new Date().toISOString(),
            message,
            accepted: false,
            note: be.message,
          },
        ];
      });
      this.store.appendEvent(jobId, {
        type: "followup.failed",
        level: "error",
        data: { code: be.code, message: be.message },
      });
      return { accepted: false, note: be.message };
    } finally {
      clearTimeout(timer);
    }
  }

  get(jobId: string): JobRecord {
    return this.store.get(jobId);
  }

  list(): JobRecord[] {
    return this.store.list();
  }

  clean(opts?: { dryRun?: boolean }): {
    removed: string[];
    completedRetentionDays: number;
    failedRetentionDays: number;
  } {
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

  private resolveTarget(origin: {
    host: JobRecord["originHost"];
    targetHost?: TargetHost;
  }): TargetHost {
    if (origin.targetHost === "cursor" || origin.targetHost === "codex") {
      return origin.targetHost;
    }
    if (origin.host === "cursor") return "codex";
    if (origin.host === "codex") return "cursor";
    throw new BridgeError(
      "BRIDGE_USAGE",
      `cannot infer target host from origin "${origin.host}"; pass origin.targetHost`,
    );
  }

  private assertModeProfile(
    mode: StartRequest["mode"],
    profile: StartRequest["permissionProfile"],
  ): void {
    const readOnlyModes = new Set([
      "investigate",
      "review",
      "adversarial-review",
      "rescue",
      "plan",
    ]);
    if (readOnlyModes.has(mode) && profile !== "read-only") {
      throw new BridgeError(
        "BRIDGE_USAGE",
        `${mode} is read-only and cannot use ${profile}`,
      );
    }
    if (mode === "implement" && profile === "read-only") {
      throw new BridgeError(
        "BRIDGE_USAGE",
        "implement requires a write profile",
      );
    }
  }

  private profileForMode(
    mode: StartRequest["mode"],
  ): StartRequest["permissionProfile"] {
    if (mode === "implement") return this.config.defaultImplementProfile;
    return this.config.defaultPermissionProfile;
  }

  private pendingAdapterName(
    targetHost: JobRecord["targetHost"],
  ): JobRecord["adapter"] {
    return targetHost === "codex" ? "codex-app-server" : "cursor-sdk";
  }

  private requestFromRecord(record: JobRecord): StartRequest {
    const meta = this.requestMeta.get(record.jobId) ?? {};
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
        ...(record.parentJobId ? { parentJobId: record.parentJobId } : {}),
      },
      ...meta,
    };
  }
}

export { DEFAULT_CONFIG, jobsDir, logsDir, defaultWorktreeRoot, loadConfig };
export type { Logger };
