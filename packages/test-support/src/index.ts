/**
 * Test support: fake agent scripts, temporary git repositories, and env
 * helpers shared by protocol/integration/security tests.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const GIT_ENV = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_AUTHOR_NAME: "bridge-test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "bridge-test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
});

export interface TempRepoOptions {
  initialCommit?: boolean;
  files?: Record<string, string>;
}

/** Create an isolated temporary git repository. */
export async function makeTempRepo(
  opts: TempRepoOptions = {},
): Promise<{ root: string; repo: string; cleanup: () => void }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-test-repo-"));
  const run = async (args: string[]): Promise<void> => {
    await execFileAsync("git", args, {
      cwd: root,
      env: GIT_ENV(),
      timeout: 30_000,
    });
  };
  await run(["init", "--initial-branch=main", "."]);
  await run(["config", "user.name", "bridge-test"]);
  await run(["config", "user.email", "test@example.invalid"]);
  fs.writeFileSync(path.join(root, ".gitignore"), ".state/\n.handoff/\n");
  for (const [rel, content] of Object.entries(
    opts.files ?? { "src/index.ts": "export const x = 1;\n" },
  )) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  if (opts.initialCommit !== false) {
    await run(["add", "-A"]);
    await run(["commit", "-m", "initial"]);
  }
  return {
    root,
    get repo() {
      return root;
    },
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

/** Script for a fake Codex app-server (CommonJS, run with `node <file>`). */
export function fakeCodexAppServer(options: {
  turnDelayMs?: number;
  failInit?: boolean;
  emitApprovalRequest?: boolean;
  malformedAfterInit?: boolean;
  exitAfterMs?: number;
  threadIdPrefix?: string;
}): string {
  const optsJson = JSON.stringify(options);
  return `
const opts = ${optsJson};
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
function send(o){ if (process.stdout.writable) process.stdout.write(JSON.stringify(o) + "\\n"); }
let turnStarted = false;
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    if (opts.failInit) { send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "init refused" } }); return; }
    send({ jsonrpc: "2.0", id: msg.id, result: { codexHome: "/tmp/ccb-fake", platformFamily: "unix", platformOs: "test", userAgent: "codex-fake/1.0.0" } });
    if (opts.malformedAfterInit) { process.stdout.write("THIS IS NOT JSON\\n"); }
  } else if (msg.method === "thread/start") {
    const id = (opts.threadIdPrefix || "thr-fake-") + Math.random().toString(16).slice(2, 10);
    send({ jsonrpc: "2.0", method: "thread/started", params: { thread: { id, sessionId: id, turns: [], preview: "", status: "idle", createdAt: 0, updatedAt: 0, cliVersion: "fake", cwd: process.cwd(), ephemeral: false, modelProvider: "fake", source: "test" } } });
    send({ jsonrpc: "2.0", id: msg.id, result: { thread: { id, sessionId: id, turns: [], preview: "", status: "idle", createdAt: 0, updatedAt: 0, cliVersion: "fake", cwd: process.cwd(), ephemeral: false, modelProvider: "fake", source: "test" }, model: "fake", modelProvider: "fake", approvalPolicy: "never", sandbox: "read-only", cwd: process.cwd() } });
  } else if (msg.method === "thread/resume") {
    const id = msg.params && msg.params.threadId;
    send({ jsonrpc: "2.0", id: msg.id, result: { thread: { id, sessionId: id, turns: [], preview: "resumed", status: "idle", createdAt: 0, updatedAt: 0, cliVersion: "fake", cwd: process.cwd(), ephemeral: false, modelProvider: "fake", source: "test" } } });
  } else if (msg.method === "turn/start") {
    const p = msg.params || {};
    turnStarted = true;
    send({ jsonrpc: "2.0", method: "turn/started", params: { threadId: p.threadId, turn: { id: "turn-1", items: [], status: "inProgress" } } });
    const emit = () => {
      if (opts.emitApprovalRequest) {
        send({ jsonrpc: "2.0", id: "srv-1", method: "execCommandApproval", params: { threadId: p.threadId, turnId: "turn-1", command: "rm -rf /", cwd: process.cwd(), reason: "test" } });
      }
      send({ jsonrpc: "2.0", method: "item/completed", params: { threadId: p.threadId, turnId: "turn-1", completedAtMs: Date.now(), item: { id: "i1", type: "commandExecution", command: "echo fake", exitCode: 0, aggregatedOutput: "fake output with sk-abcdefghijklmnopqrstuvwx token", cwd: process.cwd(), status: "completed", commandActions: [] } } });
      send({ jsonrpc: "2.0", method: "item/completed", params: { threadId: p.threadId, turnId: "turn-1", completedAtMs: Date.now(), item: { id: "i2", type: "agentMessage", text: "fake final message. ## Bridge summary\\nAll clear." } } });
      send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: p.threadId, turn: { id: "turn-1", items: [], status: "completed" } } });
      send({ jsonrpc: "2.0", id: msg.id, result: { turnId: "turn-1" } });
    };
    if (opts.turnDelayMs) setTimeout(emit, opts.turnDelayMs); else emit();
  } else if (msg.method === "turn/interrupt") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    setTimeout(() => process.exit(0), 50);
  } else if (msg.id !== undefined && msg.id !== null) {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
if (opts.exitAfterMs) setTimeout(() => process.exit(9), opts.exitAfterMs);
else setTimeout(() => process.exit(0), 120000);
`;
}

/** Script for a fake Cursor ACP agent (CommonJS, run with `node <file>`). */
export function fakeCursorAcp(options: {
  failInit?: boolean;
  requestPermission?: boolean;
  turnDelayMs?: number;
  refusal?: boolean;
}): string {
  const optsJson = JSON.stringify(options);
  return `
const opts = ${optsJson};
const readline = require("readline");
const rl = readline.createInterface({ input: process.stdin });
function send(o){ if (process.stdout.writable) process.stdout.write(JSON.stringify(o) + "\\n"); }
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    if (opts.failInit) { send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "nope" } }); return; }
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-fake-" + Math.random().toString(16).slice(2, 10) } });
  } else if (msg.method === "session/load") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: (msg.params || {}).sessionId } });
  } else if (msg.method === "session/prompt") {
    const sessionId = (msg.params || {}).sessionId;
    const emit = () => {
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", title: "fake tool" } } });
      send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fake agent output" } } } });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: opts.refusal ? "refusal" : "end_turn" } });
    };
    if (opts.turnDelayMs) setTimeout(emit, opts.turnDelayMs); else emit();
  } else if (msg.method === "session/request_permission") {
    send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: "deny-once" } } });
  } else if (msg.id !== undefined && msg.id !== null) {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
setTimeout(() => process.exit(0), 120000);
`;
}

/** Materialize a fake agent script to a temp file and clean up with the repo. */
export function materializeFake(
  dir: string,
  name: string,
  script: string,
): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, script, { mode: 0o755 });
  return file;
}

/** Wait until a condition or timeout; avoids sleep-polling in tests where possible. */
export async function waitFor(
  pred: () => boolean,
  timeoutMs = 5000,
  stepMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error("waitFor: condition not met before timeout");
}
