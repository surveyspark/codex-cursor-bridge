import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  JobManager,
  buildToolRouter,
  makeTempRepo,
  fakeCodexAppServer,
  materializeFake,
  CodexAppServerAdapter,
  waitFor,
} from "../helpers.js";

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const c of cleanups) c();
});

describe("MCP tool router background start", () => {
  it("codex_start with background:true returns before the agent turn finishes", async () => {
    const { repo, cleanup } = await makeTempRepo({});
    cleanups.push(cleanup);
    process.env.CCB_STATE_DIR = path.join(repo, ".state");
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-router-"));
    cleanups.push(() => fs.rmSync(scratch, { recursive: true, force: true }));
    const fake = materializeFake(
      scratch,
      "fake-slow.cjs",
      fakeCodexAppServer({ turnDelayMs: 4_000 }),
    );
    const manager = new JobManager({
      repoRoot: repo,
      config: { worktreeRoot: path.join(scratch, "worktrees") },
      selectAdapter: async () => ({
        adapter: new CodexAppServerAdapter({
          argvOverride: [process.execPath, fake],
        }),
        reason: "fake slow",
      }),
    });
    const tools = buildToolRouter({
      originHost: "cursor",
      prefix: "codex",
      manager,
    });
    const start = tools.find((t) => t.name === "codex_start");
    const status = tools.find((t) => t.name === "codex_status");
    expect(start && status).toBeTruthy();

    const began = Date.now();
    const started = await start!.handler({
      task: "background me",
      cwd: repo,
      mode: "investigate",
      permissionProfile: "read-only",
      background: true,
    });
    const elapsed = Date.now() - began;
    expect(elapsed).toBeLessThan(2_000);
    const payload = started.payload as {
      jobId: string;
      status: string;
      nativeId: string | null;
    };
    expect(payload.status).toBe("queued");
    expect(payload.nativeId).toBeNull();
    expect(payload.jobId).toMatch(/^job_/);

    await waitFor(() => {
      const rec = manager.get(payload.jobId);
      return rec.status === "running" || rec.status === "completed";
    }, 8_000);
    const st = await status!.handler({ jobId: payload.jobId });
    const stPayload = st.payload as { jobId: string; status: string };
    expect(stPayload.jobId).toBe(payload.jobId);
    expect(["queued", "starting", "running", "completed"]).toContain(
      stPayload.status,
    );
  }, 20_000);
});
