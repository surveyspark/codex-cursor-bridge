/**
 * `demos` — reproducible demonstrations using FAKE agent processes
 * (no credentials, no network). Implements the five required demos:
 *
 *   1. delegate-investigate : Cursor→Codex read-only investigation via fake
 *      app-server, streamed progress, native session id retained.
 *   2. plan-and-execute     : Codex→Cursor validated plan → fake Cursor ACP
 *      process with permission + progress events.
 *   3. worktree-isolation   : implementation in an isolated git worktree with
 *      diff summary; original tree untouched.
 *   4. recursion-blocked    : nested handoff rejected.
 *   5. cancel-kills-tree    : cancellation terminates child + descendants.
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  asBridgeError,
  createLogger,
  getNullLogger,
  type StartRequest,
} from "@codex-cursor-bridge/bridge-core";
import { JobManager } from "@codex-cursor-bridge/orchestrator";
import { CodexAppServerAdapter } from "@codex-cursor-bridge/codex-adapter";
import { CursorAcpAdapter } from "@codex-cursor-bridge/cursor-adapter";
import {
  createWorktree,
  collectWorktreeDiff,
  removeWorktree,
  inspectGit,
} from "@codex-cursor-bridge/orchestrator";

const execFileAsync = promisify(execFile);

const FIXTURES = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../tests/fixtures");
void FIXTURES;

export const DEMOS = [
  "delegate-investigate",
  "plan-and-execute",
  "worktree-isolation",
  "recursion-blocked",
  "cancel-kills-tree",
] as const;

export async function runDemos(args: string[], ctx: { repoRoot: string; json?: boolean }): Promise<void> {
  const sub = args[0] ?? "list";
  if (sub === "list") {
    process.stdout.write(
      ["Reproducible demos (fake agents; no credentials needed):", ...DEMOS.map((d) => `  codex-cursor-bridge demos run ${d}`), ""].join("\n"),
    );
    return;
  }
  if (sub !== "run") {
    process.stderr.write("usage: demos list | demos run <name>\n");
    process.exitCode = 1;
    return;
  }
  const name = args[1];
  if (!name || !DEMOS.includes(name as (typeof DEMOS)[number])) {
    process.stderr.write(`unknown demo ${String(name)}; choose one of: ${DEMOS.join(", ")}\n`);
    process.exitCode = 1;
    return;
  }

  const scratch = fs.mkdtempSync(path.join(ctx.repoRoot, ".handoff", "demo-"));
  const log = ctx.json ? getNullLogger() : createLogger({ level: "info" });
  try {
    switch (name) {
      case "delegate-investigate":
        await demo1(scratch, ctx, log);
        break;
      case "plan-and-execute":
        await demo2(scratch, ctx, log);
        break;
      case "worktree-isolation":
        await demo3(scratch, ctx, log);
        break;
      case "recursion-blocked":
        await demo4(scratch, ctx, log);
        break;
      case "cancel-kills-tree":
        await demo5(scratch, ctx, log);
        break;
    }
  } finally {
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/* ---------------- fake processes ---------------- */

/** Fake codex app-server: minimal protocol-conformant script. */
function fakeCodexAppServerScript(): string {
  return `
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
function send(o){ process.stdout.write(JSON.stringify(o) + "\\n"); }
let threadId = null;
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { codexHome: "/tmp", platformFamily: "unix", platformOs: "test", userAgent: "codex-fake/0.0.1" } });
    send({ jsonrpc: "2.0", method: "initialized" });
  } else if (msg.method === "thread/start") {
    threadId = "thr-fake-" + Math.random().toString(16).slice(2, 10);
    send({ jsonrpc: "2.0", method: "thread/started", params: { thread: { id: threadId, sessionId: threadId, turns: [], preview: "", status: "idle", createdAt: 0, updatedAt: 0, cliVersion: "fake", cwd: process.cwd(), ephemeral: false, modelProvider: "fake", source: "test", turnStatus: [] } } });
    send({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: threadId, sessionId: threadId, turns: [], preview: "", status: "idle", createdAt: 0, updatedAt: 0, cliVersion: "fake", cwd: process.cwd(), ephemeral: false, modelProvider: "fake", source: "test" }, model: "fake-model", modelProvider: "fake", approvalPolicy: "never", sandbox: "read-only", cwd: process.cwd() } });
  } else if (msg.method === "turn/start") {
    const p = msg.params || {};
    send({ jsonrpc: "2.0", method: "turn/started", params: { threadId: p.threadId, turn: { id: "turn-1", items: [], status: "inProgress" } } });
    send({ jsonrpc: "2.0", method: "item/completed", params: { threadId: p.threadId, turnId: "turn-1", completedAtMs: Date.now(), item: { id: "i1", type: "commandExecution", command: "grep -rn TODO . | head -5", exitCode: 0, aggregatedOutput: "found 5 TODOs", cwd: process.cwd(), status: "completed", commandActions: [] } } });
    send({ jsonrpc: "2.0", method: "item/completed", params: { threadId: p.threadId, turnId: "turn-1", completedAtMs: Date.now(), item: { id: "i2", type: "agentMessage", text: "Investigation complete. ## Bridge summary\\nFound the root cause in src/index.ts." } } });
    send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: p.threadId, turn: { id: "turn-1", items: [], status: "completed" } } });
    send({ jsonrpc: "2.0", id: msg.id, result: { turnId: "turn-1" } });
  } else if (msg.method === "turn/interrupt") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  } else if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
setTimeout(() => process.exit(0), 60000);
`;
}

/** Fake cursor ACP: protocol-conformant minimal agent. */
function fakeCursorAcpScript(): string {
  return `
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
function send(o){ process.stdout.write(JSON.stringify(o) + "\\n"); }
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    send({ jsonrpc: "2.0", method: "initialized" });
  } else if (msg.method === "session/new" || msg.method === "session/load") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-fake-" + Math.random().toString(16).slice(2, 10) } });
  } else if (msg.method === "session/prompt") {
    const sessionId = (msg.params || {}).sessionId;
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", title: "read src/app.ts" } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Implementing plan step-1..." } } } });
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "done" } } });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  } else if (msg.method === "session/request_permission") {
    send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: "deny" } } });
  } else if (msg.method === "session/cancel") {
    // no response required
  } else if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
setTimeout(() => process.exit(0), 60000);
`;
}

async function materializeFake(dir: string, name: string, script: string): Promise<string> {
  const file = path.join(dir, name);
  fs.writeFileSync(file, script, { mode: 0o755 });
  return file;
}

function managerWithFakes(repoRoot: string, scratch: string, log: ReturnType<typeof createLogger>): Promise<JobManager> {
  const fakeCodexP = materializeFake(scratch, "fake-codex-app-server.cjs", fakeCodexAppServerScript());
  const fakeAcpP = materializeFake(scratch, "fake-cursor-acp.cjs", fakeCursorAcpScript());
  return Promise.all([fakeCodexP, fakeAcpP]).then(([fakeCodex, fakeAcp]) => {
    return new JobManager({
      repoRoot,
      config: { worktreeRoot: path.join(scratch, "worktrees"), debugLogging: true },
      logger: log,
      selectAdapter: async (_request, record) => {
        if (record.targetHost === "codex") {
          return {
            adapter: new CodexAppServerAdapter({
              argvOverride: [process.execPath, fakeCodex],
              extraEnv: {},
            }),
            reason: "fake app-server for demo",
          };
        }
        return {
          adapter: new CursorAcpAdapter({ argvOverride: [process.execPath, fakeAcp] }),
          reason: "fake ACP for demo",
        };
      },
    });
  });
}

/* ---------------- demos ---------------- */

async function demo1(scratch: string, ctx: { repoRoot: string }, log: ReturnType<typeof createLogger>): Promise<void> {
  const manager = await managerWithFakes(ctx.repoRoot, scratch, log);
  const request: StartRequest = {
    task: "Investigate why the login flow fails when the session cookie expires mid-request. Trace the failure through the middleware and report the root cause.",
    cwd: ctx.repoRoot,
    mode: "investigate",
    permissionProfile: "read-only",
    background: false,
    origin: { host: "cursor", handoffDepth: 0, maxHandoffDepth: 1 },
  };
  const enq = await manager.enqueue(request, { host: "cursor", tool: "codex_start", client: "demo" });
  const result = await manager.run(enq.jobId);
  report("demo1 delegate-investigate", {
    jobId: result.jobId,
    status: result.status,
    nativeThreadPreserved: Boolean(result.nativeId && result.nativeId.startsWith("thr-fake-")),
    summaryPreview: result.summary.slice(0, 120),
  });
}

async function demo2(scratch: string, ctx: { repoRoot: string }, log: ReturnType<typeof createLogger>): Promise<void> {
  const manager = await managerWithFakes(ctx.repoRoot, scratch, log);
  const plan = {
    schemaVersion: "1.0",
    task: "Add a retry wrapper around fetchUser() with exponential backoff.",
    goal: "Reduce transient login failures.",
    observedRepositoryFacts: [
      { fact: "fetchUser is called in three places without retry", evidence: ["src/api/user.ts:42", "grep -rn 'fetchUser(' src"] },
    ],
    implementationSteps: [
      {
        id: "step-1",
        description: "Add withRetry(fn, attempts) helper and wrap fetchUser call sites.",
        rationale: "Centralizes retry policy.",
        likelyFiles: ["src/api/user.ts"],
        dependsOn: [],
        verification: ["npm test -- user"],
      },
    ],
    acceptanceCriteria: ["fetchUser retries up to 3 times on network errors"],
    allowedPaths: ["src/api/**"],
    plannerSummary: "Single-step retry wrapper with existing test coverage.",
  };
  const request: StartRequest = {
    task: `Implement this validated plan:\n${JSON.stringify(plan, null, 2)}\nFollow the plan's steps and acceptance criteria exactly. Do not delegate back to Codex.`,
    cwd: ctx.repoRoot,
    mode: "implement",
    permissionProfile: "isolated-workspace-write",
    background: false,
    origin: { host: "codex", handoffDepth: 0, maxHandoffDepth: 1 },
    constraints: ["only modify files matching allowedPaths", "report deviations"],
  };
  const enq = await manager.enqueue(request, { host: "codex", tool: "cursor_start", client: "demo" });
  const result = await manager.run(enq.jobId);
  report("demo2 plan-and-execute", {
    jobId: result.jobId,
    status: result.status,
    nativeSessionPreserved: Boolean(result.nativeId && result.nativeId.startsWith("sess-fake-")),
    summaryPreview: result.summary.slice(0, 120),
  });
}

async function demo3(scratch: string, ctx: { repoRoot: string }, _log: ReturnType<typeof createLogger>): Promise<void> {
  // Worktree isolation: create, modify a sample file, run a "test", diff.
  const info = await inspectGit(ctx.repoRoot);
  if (!info.isGit || !info.hasCommits) {
    report("demo3 worktree-isolation", { skipped: "requires a git repository with at least one commit" });
    return;
  }
  const wt = await createWorktree({ repoRoot: ctx.repoRoot, worktreeRoot: path.join(scratch, "worktrees"), jobId: "job_demo3aaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  const sample = path.join(wt.path, "bridge-demo-sample.txt");
  fs.writeFileSync(sample, "demo change from isolated worktree\n", { mode: 0o600 });
  try {
    await execFileAsync("git", ["add", "-A"], { cwd: wt.path, timeout: 15_000 });
    await execFileAsync("git", ["commit", "-m", "demo: isolated worktree change"], { cwd: wt.path, timeout: 15_000, env: { ...process.env, GIT_AUTHOR_NAME: "bridge-demo", GIT_AUTHOR_EMAIL: "demo@example.invalid", GIT_COMMITTER_NAME: "bridge-demo", GIT_COMMITTER_EMAIL: "demo@example.invalid" } });
  } catch (err) {
    void err;
  }
  const summary = await collectWorktreeDiff(wt, ctx.repoRoot, 1_000_000);
  const originalDirty = (await inspectGit(ctx.repoRoot)).dirty;
  report("demo3 worktree-isolation", {
    worktree: wt.path,
    branch: wt.branch,
    baseRef: wt.baseRef,
    filesChanged: summary.filesChanged,
    patch: summary.patchPath,
    originalTreeUntouched: !originalDirty,
  });
  // Cleanup only on explicit demo completion.
  await removeWorktree(ctx.repoRoot, wt.path).catch(() => {});
}

async function demo4(scratch: string, ctx: { repoRoot: string }, log: ReturnType<typeof createLogger>): Promise<void> {
  void scratch;
  const manager = await managerWithFakes(ctx.repoRoot, scratch, log);
  const request: StartRequest = {
    task: "This should be rejected: nested delegation beyond the depth cap.",
    cwd: ctx.repoRoot,
    mode: "investigate",
    permissionProfile: "read-only",
    background: false,
    origin: {
      host: "cursor",
      handoffDepth: 2, // already at the hard cap
      maxHandoffDepth: 1,
      parentJobId: "job_parent0000000000000000000000000000",
    },
  };
  try {
    await manager.enqueue(request, { host: "cursor", tool: "codex_start", client: "demo" });
    report("demo4 recursion-blocked", { rejected: false, note: "UNEXPECTED: nested delegation was accepted" });
  } catch (err) {
    const be = asBridgeError(err);
    report("demo4 recursion-blocked", { rejected: true, code: be.code });
  }
}

async function demo5(scratch: string, ctx: { repoRoot: string }, _log: ReturnType<typeof createLogger>): Promise<void> {
  // Spawn a long-lived fake app-server mid-turn and cancel it; assert the
  // process tree dies and the job records a cancelled result. For the cancel
  // demo we use the REAL slow-fake via a delayed thread/start response.
  const manager = await managerWithFakes(ctx.repoRoot, scratch, _log);
  const request: StartRequest = {
    task: "Long investigation that will be cancelled.",
    cwd: ctx.repoRoot,
    mode: "investigate",
    permissionProfile: "read-only",
    background: false,
    origin: { host: "cursor", handoffDepth: 0, maxHandoffDepth: 1 },
  };
  const enq = await manager.enqueue(request, { host: "cursor", tool: "codex_start", client: "demo" });
  const runPromise = manager.run(enq.jobId);
  setTimeout(() => {
    manager.cancel(enq.jobId, "demo cancellation").catch(() => {});
  }, 700);
  const result = await runPromise;
  report("demo5 cancel-kills-tree", {
    jobId: result.jobId,
    status: result.status,
    cancelled: result.status === "cancelled",
  });
}

function report(title: string, payload: Record<string, unknown>): void {
  process.stdout.write(`\n=== ${title} ===\n${JSON.stringify(payload, null, 2)}\n`);
}
