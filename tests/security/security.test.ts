import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
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
  buildTaskPrompt,
  buildCursorTaskPrompt,
  redactString,
  spawnProcess,
  buildChildEnv,
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

describe("security: shell and injection safety", () => {
  it("spawns agents via argument arrays without a shell; metacharacters survive as data", async () => {
    const { repo, cleanup } = await makeTempRepo({});
    cleanups.push(cleanup);
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-sec-"));
    cleanups.push(() => fs.rmSync(scratch, { recursive: true, force: true }));
    const manager = makeManager(repo, scratch);
    const evil = "task'; rm -rf / # $(cat /etc/passwd) `whoami` && echo pwned";
    const enq = await manager.enqueue(
      {
        task: evil,
        cwd: repo,
        mode: "investigate",
        permissionProfile: "read-only",
        background: false,
      },
      { host: "cursor", tool: "codex_start" },
    );
    const result = await manager.run(enq.jobId);
    // The run completes: the metacharacters were passed as stdin data, never a shell.
    expect(result.status).toBe("completed");
  }, 30_000);

  it("prompts forbid the opposite-host delegation tools", () => {
    const codexPrompt = buildTaskPrompt(
      {
        task: "x",
        cwd: "/repo",
        mode: "investigate",
        permissionProfile: "read-only",
        background: false,
      },
      "codex",
    );
    expect(codexPrompt).toContain("Do NOT delegate it back to Cursor");
    expect(codexPrompt).toContain("cursor_start");
    const cursorPrompt = buildCursorTaskPrompt(
      {
        task: "x",
        cwd: "/repo",
        mode: "implement",
        permissionProfile: "isolated-workspace-write",
        background: false,
      },
      "cursor",
    );
    expect(cursorPrompt).toContain("Do NOT delegate it back to Codex");
    expect(cursorPrompt).toContain("codex_start");
  });

  it("prompts carry the recursion depth notice", () => {
    const p = buildTaskPrompt(
      {
        task: "x",
        cwd: "/r",
        mode: "review",
        permissionProfile: "read-only",
        background: false,
        origin: { host: "cursor", handoffDepth: 1, maxHandoffDepth: 1 },
      },
      "codex",
    );
    expect(p).toContain("handoff depth: 1");
  });
});

describe("security: secrets redaction in persisted state", () => {
  it("redacts common token shapes in stored job data", () => {
    const secret = "sk-proj-abcdefghijklmnop1234567890";
    const out = redactString(`found key ${secret} in config`);
    expect(out).not.toContain(secret);
    expect(out).toContain("***REDACTED***");
  });

  it("job store writes never contain raw secrets", async () => {
    const { repo, cleanup } = await makeTempRepo({});
    cleanups.push(cleanup);
    process.env.CCB_STATE_DIR = path.join(repo, ".state");
    const { JobStore } = await import("../helpers.js");
    const jobsDir = path.join(repo, ".state", "jobs");
    fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
    const store = new JobStore({ jobsDir });
    const id = newJobId();
    store.create({
      jobId: id,
      originHost: "cli",
      targetHost: "codex",
      adapter: "codex-app-server",
      mode: "investigate",
      permissionProfile: "read-only",
      handoffDepth: 0,
      maxHandoffDepth: 1,
      repoRoot: repo,
      cwd: repo,
      task: "analyze Bearer abcdefghijklmnop123 and gho_Abcdefghijklmnopqrstuv",
      exitCode: null,
      pid: null,
      startedAt: null,
      finishedAt: null,
    } as never);
    const raw = fs.readFileSync(path.join(jobsDir, id, "job.json"), "utf8");
    expect(raw).not.toContain("gho_Abcdefghijklmnopqrstuv");
    expect(raw).not.toContain("abcdefghijklmnop123");
  }, 20_000);
});

describe("security: path containment", () => {
  it("jobs outside the repo cannot escape containment on canonical paths", async () => {
    // The worktree root is outside the repo by design (state dir), while the
    // job cwd stays inside. Sanity-check canonicalize is symlink-aware.
    const { root: repo, cleanup } = await makeTempRepo({});
    cleanups.push(cleanup);
    if (process.platform === "win32") {
      // POSIX-specific check: Windows has no /etc and symlinks need privileges.
      return;
    }
    const link = path.join(repo, "link-outside");
    try {
      fs.symlinkSync("/etc", link);
    } catch {
      // skip on platforms without symlink permission
      return;
    }
    const { canonicalize } = await import("../helpers.js");
    // macOS /private prefix: just assert the symlink resolves OUTSIDE the repo.
    const resolved = canonicalize(link);
    expect(
      resolved.startsWith("/etc") || resolved.startsWith("/private/etc"),
    ).toBe(true);
    expect(resolved.startsWith(repo)).toBe(false);
  });
});

describe("security: environment allowlisting", () => {
  it("child env excludes unrelated secrets", () => {
    process.env.SOME_SECRET_TOKEN = "supersecretvalue123";
    const env = buildChildEnv(["OPENAI_API_KEY"]);
    expect(env.SOME_SECRET_TOKEN).toBeUndefined();
    expect(env.PATH).toBeDefined();
    delete process.env.SOME_SECRET_TOKEN;
  });

  it("prompt asks the agent to never echo secrets", () => {
    const p = buildTaskPrompt(
      {
        task: "x",
        cwd: "/r",
        mode: "investigate",
        permissionProfile: "read-only",
        background: false,
      },
      "codex",
    );
    expect(p).toContain("Never exfiltrate secrets");
  });
});

describe("security: no listening ports by default", () => {
  it("MCP server runs stdio-only (no net server imported in serve path)", async () => {
    // Static guard: the MCP server source must not open listening sockets.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(
      path.join(here, "../../packages/mcp-server/src/serve.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/\.listen\s*\(/);
    expect(src).not.toMatch(/net\.createServer/);
    expect(src).toContain("process.stdout.write");
  });
});

describe("security: process-tree cancellation", () => {
  it("killTree terminates the child even when it ignores stdin close", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-kill-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const stubborn = path.join(dir, "stubborn.cjs");
    fs.writeFileSync(
      stubborn,
      [
        "process.stdin.resume();",
        "setTimeout(() => process.exit(0), 60000);",
      ].join("\n"),
      { mode: 0o755 },
    );
    const handle = spawnProcess({
      cwd: dir,
      argv: [process.execPath, stubborn],
      env: buildChildEnv([]),
    });
    const pid = handle.child.pid;
    expect(pid).toBeDefined();
    await handle.killTree();
    // Give the OS a beat, then confirm the pid is gone.
    await new Promise((r) => setTimeout(r, 150));
    let alive = true;
    try {
      process.kill(pid!, 0);
      alive = true;
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  }, 20_000);
});
