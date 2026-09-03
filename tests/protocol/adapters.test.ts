import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  JobStore,
  newJobId,
  makeTempRepo,
  fakeCodexAppServer,
  fakeCursorAcp,
  materializeFake,
  CodexAppServerAdapter,
  CursorAcpAdapter,
  CursorCliFallbackAdapter,
  CodexExecAdapter,
} from "../helpers.js";

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const c of cleanups) c();
});

function ctx(
  overrides: Partial<Parameters<CodexAppServerAdapter["run"]>[1]> = {},
): Parameters<CodexAppServerAdapter["run"]>[1] {
  return {
    jobId: "job_" + "0".repeat(32),
    cwd: os.tmpdir(),
    abortSignal: new AbortController().signal,
    onNativeId: () => {},
    emit: () => {},
    approval: () => {},
    debugLogging: false,
    networkPolicy: "denied",
    maxOutputBytes: 1_000_000,
    ...overrides,
  } as Parameters<CodexAppServerAdapter["run"]>[1];
}

function request(
  overrides: Partial<Parameters<CodexAppServerAdapter["run"]>[0]> = {},
): Parameters<CodexAppServerAdapter["run"]>[0] {
  return {
    task: "test task",
    cwd: os.tmpdir(),
    mode: "investigate",
    permissionProfile: "read-only",
    background: false,
    origin: { host: "cursor", handoffDepth: 0, maxHandoffDepth: 1 },
    ...overrides,
  } as Parameters<CodexAppServerAdapter["run"]>[0];
}

describe("codex app-server adapter protocol", () => {
  it("completes initialize → thread/start → turn/start and preserves the native thread id", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-proto-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const fake = materializeFake(dir, "fake.cjs", fakeCodexAppServer({}));
    const adapter = new CodexAppServerAdapter({
      argvOverride: [process.execPath, fake],
    });
    const nativeIds: string[] = [];
    const events: string[] = [];
    const res = await adapter.run(
      request(),
      ctx({
        cwd: dir,
        onNativeId: (n) => nativeIds.push(n),
        emit: (e) => events.push(e.type),
      }),
    );
    expect(res.status).toBe("completed");
    expect(res.nativeId).toMatch(/^thr-fake-/);
    expect(nativeIds.length).toBeGreaterThan(0);
    expect(events).toContain("turn.started");
    expect(events).toContain("item.completed");
    expect(events).toContain("turn.completed");
    expect(res.summary).toContain("fake final message");
  }, 20_000);

  it("records commands from commandExecution items", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-proto-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const fake = materializeFake(dir, "fake.cjs", fakeCodexAppServer({}));
    const adapter = new CodexAppServerAdapter({
      argvOverride: [process.execPath, fake],
    });
    const res = await adapter.run(request(), ctx({ cwd: dir }));
    expect(res.commands?.length).toBeGreaterThan(0);
    expect(res.commands?.[0]?.command).toContain("echo fake");
    expect(res.commands?.[0]?.aggregatedStatus).toBe("success");
  }, 20_000);

  it("auto-denies exec approval requests and continues", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-proto-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const fake = materializeFake(
      dir,
      "fake.cjs",
      fakeCodexAppServer({ emitApprovalRequest: true }),
    );
    const adapter = new CodexAppServerAdapter({
      argvOverride: [process.execPath, fake],
    });
    const approvals: Array<{ kind: string; decision: string }> = [];
    const res = await adapter.run(
      request(),
      ctx({
        cwd: dir,
        approval: (a) => approvals.push({ kind: a.kind, decision: a.decision }),
      }),
    );
    expect(res.status).toBe("completed");
    expect(approvals.length).toBeGreaterThan(0);
    expect(approvals[0]?.decision).toBe("auto-denied");
  }, 20_000);

  it("survives malformed JSON lines from the child", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-proto-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const fake = materializeFake(
      dir,
      "fake.cjs",
      fakeCodexAppServer({ malformedAfterInit: true }),
    );
    const adapter = new CodexAppServerAdapter({
      argvOverride: [process.execPath, fake],
    });
    const res = await adapter.run(request(), ctx({ cwd: dir }));
    expect(res.status).toBe("completed");
  }, 20_000);

  it("handles unexpected child exit as failure", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-proto-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    // Fake exits 3s after start, mid-turn.
    const fake = materializeFake(
      dir,
      "fake.cjs",
      fakeCodexAppServer({ turnDelayMs: 60_000, exitAfterMs: 1500 }),
    );
    const adapter = new CodexAppServerAdapter({
      argvOverride: [process.execPath, fake],
    });
    const res = await adapter.run(request(), ctx({ cwd: dir }));
    expect(res.status).toBe("failed");
    expect(res.failure?.code).toBe("CHILD_EXITED");
  }, 30_000);

  it("supports thread resume follow-up preserving the id", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-proto-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const fake = materializeFake(dir, "fake.cjs", fakeCodexAppServer({}));
    const adapter = new CodexAppServerAdapter({
      argvOverride: [process.execPath, fake],
    });
    const res = await adapter.reply!(
      "thr-fake-xyz",
      "follow-up question",
      ctx({ cwd: dir }),
    );
    expect(res.status).toBe("completed");
    expect(res.nativeId).toBe("thr-fake-xyz");
  }, 20_000);
});

describe("cursor ACP adapter protocol", () => {
  it("completes initialize → session/new → session/prompt and preserves the session id", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-acp-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const fake = materializeFake(dir, "fake-acp.cjs", fakeCursorAcp({}));
    const adapter = new CursorAcpAdapter({
      argvOverride: [process.execPath, fake],
    });
    const nativeIds: string[] = [];
    const res = await adapter.run(
      request(),
      ctx({
        cwd: dir,
        onNativeId: (n) => nativeIds.push(n),
      }),
    );
    expect(res.status).toBe("completed");
    expect(res.nativeId).toMatch(/^sess-fake-/);
    expect(nativeIds.length).toBeGreaterThan(0);
    expect(res.summary).toContain("fake agent output");
  }, 20_000);

  it("denies permission requests (relayed policy)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-acp-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const fake = materializeFake(
      dir,
      "fake-acp.cjs",
      fakeCursorAcp({ requestPermission: true }),
    );
    const adapter = new CursorAcpAdapter({
      argvOverride: [process.execPath, fake],
    });
    const approvals: Array<{ decision: string }> = [];
    const res = await adapter.run(
      request(),
      ctx({
        cwd: dir,
        approval: (a) => approvals.push({ decision: a.decision }),
      }),
    );
    expect(res.status).toBe("completed");
    expect(approvals.length).toBeGreaterThan(0);
    expect(approvals[0]?.decision).toBe("auto-denied");
  }, 20_000);
});

describe("cursor CLI fallback", () => {
  it("parses stream-json result events and session id", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-cli-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const fake = materializeFake(
      dir,
      "fake-cli.cjs",
      [
        "const NL = String.fromCharCode(10);",
        "let buf = '';",
        "process.stdin.on('data', (d) => { buf += d; });",
        "process.stdin.on('end', () => {",
        "  process.stdout.write(JSON.stringify({ type: 'system', session_id: 'sess-cli-1' }) + NL);",
        "  process.stdout.write(JSON.stringify({ type: 'assistant', session_id: 'sess-cli-1' }) + NL);",
        "  process.stdout.write(JSON.stringify({ type: 'result', session_id: 'sess-cli-1', result: 'CLI final answer', is_error: false }) + NL);",
        "  process.exit(0);",
        "});",
        "setTimeout(() => process.exit(0), 60000);",
      ].join("\n"),
    );
    const adapter = new CursorCliFallbackAdapter({
      allowNonInteractive: true,
      argvOverride: [process.execPath, fake],
    });
    const res = await adapter.run(request(), ctx({ cwd: dir }));
    expect(res.status).toBe("completed");
    expect(res.nativeId).toBe("sess-cli-1");
    expect(res.summary).toContain("CLI final answer");
  }, 20_000);

  it("is unavailable without explicit opt-in", async () => {
    const adapter = new CursorCliFallbackAdapter({
      allowNonInteractive: false,
    });
    const st = await adapter.isAvailable();
    expect(st.available).toBe(false);
    expect(st.reason).toContain("opt-in");
  });
});

describe("codex exec fallback", () => {
  it("reports one-shot continuation honestly", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-exec-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    // Fake `codex exec` that emits --json events.
    const fake = materializeFake(
      dir,
      "fake-exec.cjs",
      [
        "const NL = String.fromCharCode(10);",
        "process.stdout.write(JSON.stringify({ msg: { type: 'thread_started', payload: { thread_id: 'ses-123' } } }) + NL);",
        "process.stdout.write(JSON.stringify({ msg: { type: 'agent_message', payload: { message: 'exec done' } } }) + NL);",
        "process.exit(0);",
      ].join("\n"),
    );
    const adapter = new CodexExecAdapter({
      argvOverride: [process.execPath, fake],
    });
    const res = await adapter.run(request(), ctx({ cwd: dir }));
    expect(res.status).toBe("completed");
    expect(res.summary).toContain("exec done");
    expect(res.nativeId).toBe("ses-123");
    expect(res.continuation.supported).toBe(false);
    expect(res.continuation.how).toContain("codex exec resume");
  }, 20_000);

  it("passes sandbox_workspace_write.network_access matching ctx.networkPolicy", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-exec-net-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const fake = materializeFake(
      dir,
      "fake-exec.cjs",
      [
        'require("fs").writeFileSync("argv.json", JSON.stringify(process.argv));',
        "const NL = String.fromCharCode(10);",
        "process.stdout.write(JSON.stringify({ msg: { type: 'agent_message', payload: { message: 'exec done' } } }) + NL);",
        "process.exit(0);",
      ].join("\n"),
    );
    const adapter = new CodexExecAdapter({
      argvOverride: [process.execPath, fake],
    });
    await adapter.run(request(), ctx({ cwd: dir, networkPolicy: "denied" }));
    const argv = JSON.parse(
      fs.readFileSync(path.join(dir, "argv.json"), "utf8"),
    ) as string[];
    const flagAt = argv.indexOf("-c");
    expect(flagAt).toBeGreaterThan(-1);
    expect(argv[flagAt + 1]).toBe(
      "sandbox_workspace_write.network_access=false",
    );
  }, 20_000);
});

describe("cursor ACP permission deny", () => {
  it("cancels when no reject option exists instead of selecting an allow", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-acp-deny-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const fake = materializeFake(
      dir,
      "fake-acp.cjs",
      fakeCursorAcp({
        requestPermission: true,
        permissionOptionKinds: ["allow_once", "allow_always"],
      }),
    );
    const adapter = new CursorAcpAdapter({
      argvOverride: [process.execPath, fake],
    });
    const approvals: Array<{ decision: string; reason?: string }> = [];
    const res = await adapter.run(
      request(),
      ctx({
        cwd: dir,
        approval: (a) =>
          approvals.push({
            decision: a.decision,
            ...(a.reason !== undefined ? { reason: a.reason } : {}),
          }),
      }),
    );
    expect(res.status).toBe("completed");
    expect(approvals.length).toBeGreaterThan(0);
    expect(approvals[0]?.decision).toBe("auto-denied");
    expect(approvals[0]?.reason).toMatch(/cancelled|no reject/i);
  }, 20_000);
});

describe("job store", () => {
  it("persists, lists, transitions, and cleans up jobs atomically", async () => {
    const { root: repo, cleanup } = await makeTempRepo({});
    cleanups.push(cleanup);
    process.env.CCB_STATE_DIR = path.join(repo, ".state");
    const jobsDir = path.join(repo, ".state", "jobs");
    fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
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
      task: "t",
      exitCode: null,
      pid: null,
      startedAt: null,
      finishedAt: null,
    } as never);
    expect(store.exists(id)).toBe(true);
    expect(() => store.get("../../etc/passwd")).toThrow(
      /JOB_NOT_FOUND|not found/,
    );
    store.setStatus(id, "starting");
    store.setStatus(id, "running");
    store.appendEvent(id, { type: "test.event" });
    const rec = store.get(id);
    expect(rec.status).toBe("running");
    expect(rec.events.some((e) => e.type === "test.event")).toBe(true);
    // Invalid transition rejected:
    expect(() => store.setStatus(id, "queued")).toThrow();
    // Secrets are never stored: write a fake key into task, read back.
    store.update(id, (r) => {
      r.task = "leak sk-abcdefghijklmnop123456";
    });
    const raw = fs.readFileSync(store.jobFile(id), "utf8");
    expect(raw).not.toContain("sk-abcdefghijklmnop123456");
    // Cleanup (fresh store instance picks up new retention config).
    const store2 = new JobStore({ jobsDir });
    store2.update(id, (r) => {
      r.status = "completed";
      r.finishedAt = new Date(Date.now() - 30 * 86_400_000).toISOString();
    });
    const removed = store2.clean({
      completedRetentionDays: 7,
      failedRetentionDays: 14,
    });
    expect(removed).toContain(id);
    expect(store2.exists(id)).toBe(false);
  }, 30_000);
});
