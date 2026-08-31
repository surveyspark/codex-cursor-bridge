/**
 * Persistent job store.
 *
 * Layout: <stateRoot>/jobs/<jobId>/job.json (the JobRecord)
 *         <stateRoot>/jobs/<jobId>/debug/  (raw protocol events, only when debug enabled)
 *
 * Guarantees:
 * - Atomic writes (write temp + rename) so crashes never leave partial records.
 * - Advisory file locking (lockfile with O_EXCL semantics + stale-lock takeover)
 *   around read-modify-write cycles.
 * - Restrictive permissions (0o700 dirs, 0o600 files) on POSIX.
 * - Crash recovery: jobs stuck in non-terminal states whose owning process is
 *   gone are marked failed on `recover()`.
 * - Retention: `clean()` deletes terminal jobs past their retention window.
 */

import fs from "node:fs";
import path from "node:path";
import {
  BridgeError,
  TERMINAL_JOB_STATUSES,
  isPidAlive,
  redactDeep,
  type JobRecord,
  type JobStatus,
  type JobEvent,
} from "@codex-cursor-bridge/bridge-core";

const MAX_EVENTS = 5000;
const MAX_EVENT_JSON_BYTES = 256 * 1024;

export interface JobStoreOptions {
  jobsDir: string;
}

export interface LockHandle {
  release: () => void;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class JobStore {
  constructor(private readonly opts: JobStoreOptions) {}

  get dir(): string {
    return this.opts.jobsDir;
  }

  jobDir(jobId: string): string {
    return path.join(this.opts.jobsDir, jobId);
  }

  jobFile(jobId: string): string {
    return path.join(this.jobDir(jobId), "job.json");
  }

  private ensureDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /** Create and persist a new job record. */
  create(
    init: Omit<
      JobRecord,
      "schemaVersion" | "createdAt" | "updatedAt" | "status" | "events"
    > &
      Partial<Pick<JobRecord, "status">>,
  ): JobRecord {
    if (!/^job_[0-9a-f]{32}$/.test(init.jobId)) {
      throw new BridgeError("BRIDGE_USAGE", `invalid jobId ${init.jobId}`);
    }
    const record: JobRecord = {
      schemaVersion: "1.0",
      status: "queued",
      events: [],
      ...init,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    } as JobRecord;
    const dir = this.jobDir(record.jobId);
    if (fs.existsSync(this.jobFile(record.jobId))) {
      throw new BridgeError(
        "BRIDGE_USAGE",
        `job ${record.jobId} already exists`,
      );
    }
    this.ensureDir(dir);
    this.writeAtomic(record);
    return record;
  }

  private writeAtomic(record: JobRecord): void {
    const file = this.jobFile(record.jobId);
    const tmp = path.join(
      this.jobDir(record.jobId),
      `.job.json.tmp-${process.pid}-${Date.now()}`,
    );
    const json = JSON.stringify(redactDeep(record), null, 2);
    fs.writeFileSync(tmp, json, { mode: 0o600 });
    try {
      fs.renameSync(tmp, file);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* best effort */
      }
      throw err;
    }
  }

  exists(jobId: string): boolean {
    return fs.existsSync(this.jobFile(jobId));
  }

  /** Read a job record. Throws JOB_NOT_FOUND when missing, JOB_STATE_CORRUPT when unparsable. */
  get(jobId: string): JobRecord {
    const file = this.jobFile(jobId);
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        throw new BridgeError("JOB_NOT_FOUND", `job ${jobId} not found`);
      }
      throw new BridgeError(
        "JOB_STATE_CORRUPT",
        `failed to read job ${jobId}: ${e.message}`,
        { cause: err },
      );
    }
    try {
      const parsed = JSON.parse(text) as JobRecord;
      if (parsed.jobId !== jobId) {
        throw new BridgeError(
          "JOB_STATE_CORRUPT",
          `job record id mismatch in ${file}`,
        );
      }
      return parsed;
    } catch (err) {
      if (err instanceof BridgeError) throw err;
      throw new BridgeError(
        "JOB_STATE_CORRUPT",
        `job record for ${jobId} is not valid JSON`,
        { cause: err },
      );
    }
  }

  /** Try to get a job; returns null when not found. */
  tryGet(jobId: string): JobRecord | null {
    try {
      return this.get(jobId);
    } catch (err) {
      if ((err as BridgeError).code === "JOB_NOT_FOUND") return null;
      throw err;
    }
  }

  list(): JobRecord[] {
    this.ensureDir(this.opts.jobsDir);
    const out: JobRecord[] = [];
    for (const entry of fs.readdirSync(this.opts.jobsDir, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      if (!/^job_[0-9a-f]{32}$/.test(entry.name)) continue;
      try {
        out.push(this.get(entry.name));
      } catch {
        // Unreadable/corrupt records are skipped but reported by doctor.
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Locked read-modify-write. The lock is a directory-based lockfile with
   * stale takeover after `staleMs` (default 30s).
   */
  update<T>(jobId: string, fn: (record: JobRecord) => T): T {
    this.ensureDir(this.opts.jobsDir);
    if (!fs.existsSync(this.jobDir(jobId))) {
      throw new BridgeError("JOB_NOT_FOUND", `job ${jobId} not found`);
    }
    const lockHandle = this.lock(jobId);
    try {
      const record = this.get(jobId);
      let result: T;
      try {
        result = fn(record);
      } finally {
        record.updatedAt = nowIso();
        this.writeAtomic(record);
      }
      return result;
    } finally {
      lockHandle.release();
    }
  }

  /** Append an event with truncation limits. */
  appendEvent(
    jobId: string,
    event: Omit<JobEvent, "ts"> & { ts?: string },
  ): void {
    this.update(jobId, (record) => {
      const e: JobEvent = { ts: event.ts ?? nowIso(), type: event.type };
      if (event.level !== undefined) e.level = event.level;
      if (event.data !== undefined) {
        const json = JSON.stringify(event.data);
        e.data =
          json && json.length > MAX_EVENT_JSON_BYTES
            ? { truncated: true, preview: json.slice(0, MAX_EVENT_JSON_BYTES) }
            : event.data;
      }
      record.events.push(e);
      if (record.events.length > MAX_EVENTS) {
        const drop = record.events.length - MAX_EVENTS;
        record.events.splice(0, drop);
        record.eventsTruncated = true;
      }
    });
  }

  /** Set job status with transition validation. */
  setStatus(
    jobId: string,
    next: JobStatus,
    opts: { exitCode?: number | null; finished?: boolean } = {},
  ): void {
    this.update(jobId, (record) => {
      assertTransition(record.status, next);
      record.status = next;
      if (opts.exitCode !== undefined) record.exitCode = opts.exitCode;
      if (opts.finished) record.finishedAt = nowIso();
    });
  }

  lock(jobId: string, staleMs = 30_000): LockHandle {
    const lockDir = path.join(this.jobDir(jobId), ".lock");
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        fs.mkdirSync(lockDir, { mode: 0o700 });
        // Write owner info; cleanup on process exit is best-effort.
        fs.writeFileSync(
          path.join(lockDir, "owner"),
          JSON.stringify({ pid: process.pid, at: nowIso() }),
          { mode: 0o600 },
        );
        return {
          release: () => {
            try {
              fs.rmSync(lockDir, { recursive: true, force: true });
            } catch {
              /* best effort */
            }
          },
        };
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== "EEXIST") throw err;
        // Stale lock takeover.
        try {
          const ownerFile = path.join(lockDir, "owner");
          const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8")) as {
            pid: number;
            at: string;
          };
          const ageMs = Date.now() - Date.parse(owner.at);
          if (!isPidAlive(owner.pid) || ageMs > staleMs) {
            fs.rmSync(lockDir, { recursive: true, force: true });
            continue;
          }
        } catch {
          // No owner info or unreadable: treat as stale.
          try {
            fs.rmSync(lockDir, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
          continue;
        }
        if (Date.now() > deadline) {
          throw new BridgeError(
            "JOB_LOCKED",
            `job ${jobId} is locked by another bridge process`,
          );
        }
        const wait = 50 + Math.floor(Math.random() * 50);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
      }
    }
  }

  /**
   * Crash recovery: mark non-terminal jobs as failed when their worker
   * process is gone. Returns recovered job ids.
   */
  recover(workerPids?: Map<string, number>): string[] {
    const recovered: string[] = [];
    for (const record of this.list()) {
      if (TERMINAL_JOB_STATUSES.has(record.status)) continue;
      const pid = workerPids?.get(record.jobId) ?? record.pid ?? null;
      const alive = pid !== null && isPidAlive(pid);
      if (!alive) {
        this.update(record.jobId, (r) => {
          r.status = "failed";
          r.finishedAt = nowIso();
          r.result = {
            jobId: r.jobId,
            nativeId: r.nativeId ?? null,
            adapter: r.adapter,
            status: "failed",
            summary:
              "Bridge worker exited without recording a final status (crash or system restart). The underlying agent may still have been running; inspect the repository state before retrying.",
            continuation: {
              supported: r.nativeId != null,
              how: r.nativeId
                ? `resume via native id ${r.nativeId}`
                : "not available",
            },
            failure: {
              code: "JOB_STATE_CORRUPT",
              message: "worker process lost",
              retriable: true,
            },
            startedAt: r.startedAt ?? null,
            finishedAt: nowIso(),
          };
        });
        recovered.push(record.jobId);
      }
    }
    return recovered;
  }

  /** Delete terminal jobs past retention; returns removed job ids. */
  clean(opts: {
    completedRetentionDays: number;
    failedRetentionDays: number;
    dryRun?: boolean;
  }): string[] {
    const removed: string[] = [];
    const now = Date.now();
    for (const record of this.list()) {
      if (!TERMINAL_JOB_STATUSES.has(record.status)) continue;
      const days =
        record.status === "completed"
          ? opts.completedRetentionDays
          : opts.failedRetentionDays;
      const finished = Date.parse(record.finishedAt ?? record.updatedAt);
      if (now - finished > days * 86_400_000) {
        removed.push(record.jobId);
        if (!opts.dryRun) {
          try {
            fs.rmSync(this.jobDir(record.jobId), {
              recursive: true,
              force: true,
            });
          } catch (err) {
            const e = err as NodeJS.ErrnoException;
            if (e.code !== "ENOENT") {
              throw new BridgeError(
                "BRIDGE_INTERNAL",
                `failed to remove ${record.jobId}: ${e.message}`,
                { cause: err },
              );
            }
          }
        }
      }
    }
    return removed;
  }

  /** Debug artifacts (raw protocol events) go here; only used when debugLogging is on. */
  debugDir(jobId: string): string {
    return path.join(this.jobDir(jobId), "debug");
  }
}

const ALLOWED_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  queued: ["starting", "failed", "cancelled"],
  starting: ["running", "failed", "cancelled", "timed-out"],
  running: [
    "waiting-for-approval",
    "waiting-for-input",
    "completed",
    "failed",
    "cancelled",
    "timed-out",
  ],
  "waiting-for-approval": ["running", "failed", "cancelled", "timed-out"],
  "waiting-for-input": ["running", "failed", "cancelled", "timed-out"],
  completed: [],
  failed: [],
  cancelled: [],
  "timed-out": [],
};

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (from === to) return;
  const allowed = ALLOWED_TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new BridgeError(
      "JOB_INVALID_TRANSITION",
      `invalid job status transition ${from} -> ${to}`,
      { details: { from, to } },
    );
  }
}

export function newJobId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let hex = "";
  for (let i = 0; i < bytes.length; i++)
    hex += bytes[i]!.toString(16).padStart(2, "0");
  return `job_${hex}`;
}
