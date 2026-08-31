import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  JobManager,
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

function managerWith(repoRoot: string, scratch: string) {
  const fakeCodex = materializeFake(scratch, "fake-codex.cjs", fakeCodexAppServer({}));
  const fakeAcp = materializeFake(scratch, "fake-acp.cjs", fakeCursorAcp({}));
  return new JobManager({
    repoRoot,
    config: { worktreeRoot: path.join(scratch, "worktrees") },
    selectAdapter: async (_req, record) => {
      if (record.targetHost === "codex") {
        return { adapter: new CodexAppServerAdapter({ argvOverride: [process.execPath, fakeCodex] }), reason: "fake" };
      }
      return { adapter: new CursorAcpAdapter({ argvOverride: [process.execPath, fakeAcp] }), reason: "fake" };
    },
  });
}

const PLAN = {
  schemaVersion: "1.0",
  task: "Add retry to fetchUser",
  goal: "reduce transient failures",
  observedRepositoryFacts: [
    { fact: "fetchUser lives in src/api/user.ts", evidence: ["src/api/user.ts"] },
  ],
  implementationSteps: [
    {
      id: "step-1",
      description: "wrap fetchUser with retry",
      rationale: "single choke point",
      likelyFiles: ["src/api/user.ts"],
      dependsOn: [],
      verification: ["npm test"],
    },
  ],
  acceptanceCriteria: ["fetchUser retries 3 times"],
  allowedPaths: ["src/api/**"],
  plannerSummary: "single-step retry wrapper",
};

describe("contract: plan-to-execution handoff", () => {
  it("passes the validated plan to the executor inside the task prompt", async () => {
    const { repo, cleanup } = await makeTempRepo({});
    cleanups.push(cleanup);
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-h-"));
    cleanups.push(() => fs.rmSync(scratch, { recursive: true, force: true }));
    let receivedTask = "";
    let gotConstraints: string[] | undefined;
    const fakeAcp = materializeFake(scratch, "fake-acp.cjs", fakeCursorAcp({}));
    const manager = new JobManager({
      repoRoot: repo,
      config: { worktreeRoot: path.join(scratch, "worktrees") },
      selectAdapter: async (request) => {
        receivedTask = request.task;
        gotConstraints = request.constraints;
        return { adapter: new CursorAcpAdapter({ argvOverride: [process.execPath, fakeAcp] }), reason: "fake" };
      },
    });
    const enq = await manager.enqueue(
      {
        task: `Implement this validated plan:\n${JSON.stringify(PLAN, null, 2)}\nImplement directly. Do not delegate back to Codex.`,
        cwd: repo,
        mode: "implement",
        permissionProfile: "isolated-workspace-write",
        background: false,
        constraints: ["respect allowedPaths", "report deviations"],
        expectedOutput: "changed files + test results",
      },
      { host: "codex", tool: "cursor_start" },
    );
    const result = await manager.run(enq.jobId);
    expect(result.status).toBe("completed");
    expect(receivedTask).toContain("schemaVersion");
    expect(receivedTask).toContain("step-1");
    expect(receivedTask).toContain("Do not delegate back to Codex");
    expect(gotConstraints).toContain("respect allowedPaths");
  }, 30_000);

  it("rejects invalid plans before execution (validation gate)", async () => {
    const invalid = { ...PLAN, schemaVersion: "9.9" };
    // The validation gate lives in bridge-core; a host integrating the bridge
    // must run validateHandoffPlan before cursor_start. Assert the helper.
    const { validateHandoffPlan } = await import("../helpers.js");
    const r = validateHandoffPlan(invalid);
    expect(r.ok).toBe(false);
  });

  it("lists jobs scoped per host direction", async () => {
    const { repo, cleanup } = await makeTempRepo({});
    cleanups.push(cleanup);
    process.env.CCB_STATE_DIR = path.join(repo, ".state");
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-h2-"));
    cleanups.push(() => fs.rmSync(scratch, { recursive: true, force: true }));
    const manager = managerWith(repo, scratch);
    await manager.enqueue(
      { task: "a", cwd: repo, mode: "investigate", permissionProfile: "read-only", background: false },
      { host: "cursor", tool: "codex_start" },
    );
    const jobs = manager.list();
    expect(jobs.length).toBe(1);
    expect(jobs[0]!.targetHost).toBe("codex");
  }, 20_000);

  it("follow-up on an unknown session id is reported as not accepted", async () => {
    const { repo, cleanup } = await makeTempRepo({});
    cleanups.push(cleanup);
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-h3-"));
    cleanups.push(() => fs.rmSync(scratch, { recursive: true, force: true }));
    const manager = managerWith(repo, scratch);
    const enq = await manager.enqueue(
      { task: "a", cwd: repo, mode: "investigate", permissionProfile: "read-only", background: false },
      { host: "cursor", tool: "codex_start" },
    );
    // No run: job is queued with no native id.
    const reply = await manager.reply(enq.jobId, "hello?");
    expect(reply.accepted).toBe(false);
    expect(reply.note).toContain("no native session id");
  }, 20_000);
});
