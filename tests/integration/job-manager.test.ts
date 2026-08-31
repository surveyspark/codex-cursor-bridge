import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  JobManager,
  newJobId,
  makeTempRepo,
  fakeCodexAppServer,
  fakeCursorAcp,
  materializeFake,
  CodexAppServerAdapter,
  CursorAcpAdapter,
} from "../helpers.js";

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const c of cleanups) c();
});

function makeManager(repoRoot: string, scratch: string) {
  const fakeCodex = materializeFake(
    scratch,
    "fake-codex.cjs",
    fakeCodexAppServer({}),
  );
  const fakeAcp = materializeFake(scratch, "fake-acp.cjs", fakeCursorAcp({}));
  return new JobManager({
    repoRoot,
    config: { worktreeRoot: path.join(scratch, "worktrees") },
    selectAdapter: async (_req, record) => {
      if (record.targetHost === "codex") {
        return {
          adapter: new CodexAppServerAdapter({
            argvOverride: [process.execPath, fakeCodex],
          }),
          reason: "fake",
        };
      }
      return {
        adapter: new CursorAcpAdapter({
          argvOverride: [process.execPath, fakeAcp],
        }),
        reason: "fake",
      };
    },
  });
}

describe("job manager integration", () => {
  it("runs a read-only job end-to-end and records result + native id", async () => {
    const { repo, cleanup } = await makeTempRepo({});
    cleanups.push(cleanup);
    process.env.CCB_STATE_DIR = path.join(repo, ".state");
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-int-"));
    cleanups.push(() => fs.rmSync(scratch, { recursive: true, force: true }));
    const manager = makeManager(repo, scratch);
    const enq = await manager.enqueue(
      {
        task: "investigate something",
        cwd: repo,
        mode: "investigate",
        permissionProfile: "read-only",
        background: false,
      },
      { host: "cursor", tool: "codex_start" },
    );
    const result = await manager.run(enq.jobId);
    expect(result.status).toBe("completed");
    expect(result.nativeId).toMatch(/^thr-fake-/);
    const record = manager.get(enq.jobId);
    expect(record.result?.summary).toContain("fake final message");
    expect(record.adapter).toBe("codex-app-server");
  }, 30_000);

  it("runs an implement job in an isolated worktree and produces a patch", async () => {
    const { repo, cleanup } = await makeTempRepo({
      files: { "src/app.ts": "export const a = 1;\n" },
    });
    cleanups.push(cleanup);
    process.env.CCB_STATE_DIR = path.join(repo, ".state");
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-int-"));
    cleanups.push(() => fs.rmSync(scratch, { recursive: true, force: true }));
    const fakeAcp = materializeFake(scratch, "fake-acp.cjs", fakeCursorAcp({}));
    const manager = new JobManager({
      repoRoot: repo,
      config: { worktreeRoot: path.join(scratch, "worktrees") },
      selectAdapter: async (_req, record) => {
        expect(record.targetHost).toBe("cursor");
        return {
          adapter: new CursorAcpAdapter({
            argvOverride: [process.execPath, fakeAcp],
          }),
          reason: "fake",
        };
      },
    });
    const enq = await manager.enqueue(
      {
        task: "implement a small change",
        cwd: repo,
        mode: "implement",
        permissionProfile: "isolated-workspace-write",
        background: false,
      },
      { host: "codex", tool: "cursor_start" },
    );
    const result = await manager.run(enq.jobId);
    expect(result.status).toBe("completed");
    const record = manager.get(enq.jobId);
    expect(record.worktree).toBeTruthy();
    expect(record.worktree!.path).toContain("worktrees");
    // The real repo working tree was not modified by the agent.
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const status = await promisify(execFile)("git", ["status", "--porcelain"], {
      cwd: repo,
    });
    expect(status.stdout.trim()).toBe("");
  }, 40_000);

  it("rejects nested delegation beyond the depth cap", async () => {
    const { repo, cleanup } = await makeTempRepo({});
    cleanups.push(cleanup);
    process.env.CCB_STATE_DIR = path.join(repo, ".state");
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-int-"));
    cleanups.push(() => fs.rmSync(scratch, { recursive: true, force: true }));
    const manager = makeManager(repo, scratch);
    await expect(
      manager.enqueue(
        {
          task: "nested",
          cwd: repo,
          mode: "investigate",
          permissionProfile: "read-only",
          background: false,
          origin: { host: "cursor", handoffDepth: 2, maxHandoffDepth: 1 },
        },
        { host: "cursor", tool: "codex_start" },
      ),
    ).rejects.toThrow(/RECURSION_BLOCKED|exceeds maximum/);
  }, 20_000);

  it("cancels a running job and records a cancelled result", async () => {
    const { repo, cleanup } = await makeTempRepo({});
    cleanups.push(cleanup);
    process.env.CCB_STATE_DIR = path.join(repo, ".state");
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-int-"));
    cleanups.push(() => fs.rmSync(scratch, { recursive: true, force: true }));
    // Delayed fake: turn never finishes during the test window.
    const fakeSlow = materializeFake(
      scratch,
      "fake-slow.cjs",
      fakeCodexAppServer({ turnDelayMs: 60_000 }),
    );
    const manager = new JobManager({
      repoRoot: repo,
      config: { worktreeRoot: path.join(scratch, "worktrees") },
      selectAdapter: async () => ({
        adapter: new CodexAppServerAdapter({
          argvOverride: [process.execPath, fakeSlow],
        }),
        reason: "fake slow",
      }),
    });
    const enq = await manager.enqueue(
      {
        task: "long task",
        cwd: repo,
        mode: "investigate",
        permissionProfile: "read-only",
        background: false,
      },
      { host: "cursor", tool: "codex_start" },
    );
    const runPromise = manager.run(enq.jobId);
    setTimeout(
      () => void manager.cancel(enq.jobId, "test cancel").catch(() => {}),
      500,
    );
    const result = await runPromise;
    expect(result.status).toBe("cancelled");
    expect(result.failure?.code).toBe("JOB_CANCELLED");
  }, 20_000);

  it("recovers orphaned jobs after a simulated crash", async () => {
    const { repo, cleanup } = await makeTempRepo({});
    cleanups.push(cleanup);
    const jobsDir = path.join(repo, ".state", "jobs");
    fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
    process.env.CCB_STATE_DIR = path.join(repo, ".state");
    const { JobStore } = await import("../helpers.js");
    const store = new JobStore({ jobsDir });
    const id = newJobId();
    store.create({
      jobId: id,
      originHost: "cursor",
      targetHost: "codex",
      adapter: "codex-app-server",
      mode: "investigate",
      permissionProfile: "read-only",
      handoffDepth: 0,
      maxHandoffDepth: 1,
      repoRoot: repo,
      cwd: repo,
      task: "orphan",
      status: "running",
      exitCode: null,
      pid: 999999999, // not alive
      startedAt: new Date().toISOString(),
      finishedAt: null,
    } as never);
    const recovered = store.recover();
    expect(recovered).toContain(id);
    const rec = store.get(id);
    expect(rec.status).toBe("failed");
  }, 20_000);

  it("handles a dirty working tree in current-workspace-write with a warning", async () => {
    const { repo, cleanup } = await makeTempRepo({});
    cleanups.push(cleanup);
    process.env.CCB_STATE_DIR = path.join(repo, ".state");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    fs.writeFileSync(path.join(repo, "dirty.txt"), "uncommitted\n");
    await run("git", ["add", "dirty.txt"], { cwd: repo });
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-int-"));
    cleanups.push(() => fs.rmSync(scratch, { recursive: true, force: true }));
    const fakeAcp = materializeFake(scratch, "fake-acp.cjs", fakeCursorAcp({}));
    const manager = new JobManager({
      repoRoot: repo,
      config: { worktreeRoot: path.join(scratch, "worktrees") },
      selectAdapter: async () => ({
        adapter: new CursorAcpAdapter({
          argvOverride: [process.execPath, fakeAcp],
        }),
        reason: "fake",
      }),
    });
    const enq = await manager.enqueue(
      {
        task: "edit current tree",
        cwd: repo,
        mode: "implement",
        permissionProfile: "current-workspace-write",
        background: false,
      },
      { host: "codex", tool: "cursor_start" },
    );
    await manager.run(enq.jobId);
    const record = manager.get(enq.jobId);
    const warn = record.events.find((e) => e.type === "worktree.skipped");
    expect(warn).toBeTruthy();
  }, 40_000);
});
