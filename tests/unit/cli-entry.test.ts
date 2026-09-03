import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isCliEntrypoint } from "../../packages/cli/src/shared.js";
import { runDoctor } from "../../packages/cli/src/doctor.js";
import { cliJobOrigin, jobsForCliHost } from "../../packages/cli/src/origin.js";

describe("CLI entrypoint detection", () => {
  it("matches a native path for this module", () => {
    const meta = import.meta.url;
    const native = fileURLToPath(meta);
    expect(isCliEntrypoint(meta, native)).toBe(true);
  });

  it("treats backslash argv[1] as equivalent to the forward-slash path", () => {
    const meta = import.meta.url;
    const native = fileURLToPath(meta);
    const backslash = native.replace(/\//g, "\\");
    expect(isCliEntrypoint(meta, backslash)).toBe(true);
  });

  it("does not treat an unrelated path as main", () => {
    expect(isCliEntrypoint(import.meta.url, "/tmp/some-other-script.mjs")).toBe(
      false,
    );
  });
});

describe("CLI origin mapping", () => {
  it("cursor start targets Cursor, not Codex", () => {
    expect(cliJobOrigin("cursor")).toEqual({
      host: "cli",
      tool: "cli",
      client: "terminal",
      targetHost: "cursor",
    });
    expect(cliJobOrigin("codex").targetHost).toBe("codex");
  });

  it("cursor list sees only Cursor jobs", () => {
    const jobs = [
      { jobId: "job_cursor", targetHost: "cursor" },
      { jobId: "job_codex", targetHost: "codex" },
    ];
    expect(jobsForCliHost(jobs, "cursor").map((j) => j.jobId)).toEqual([
      "job_cursor",
    ]);
    expect(jobsForCliHost(jobs, "codex").map((j) => j.jobId)).toEqual([
      "job_codex",
    ]);
  });
});

describe("doctor", () => {
  const previousState = process.env.CCB_STATE_DIR;
  const previousPath = process.env.PATH;
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
    if (previousState === undefined) delete process.env.CCB_STATE_DIR;
    else process.env.CCB_STATE_DIR = previousState;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });

  function pathWithoutAgentBins(): string {
    const names = new Set(["codex", "agent", "cursor-agent", "cursor"]);
    return (process.env.PATH ?? "")
      .split(path.delimiter)
      .filter((dir) => {
        if (!dir) return false;
        for (const n of names) {
          if (
            fs.existsSync(path.join(dir, n)) ||
            fs.existsSync(path.join(dir, `${n}.exe`)) ||
            fs.existsSync(path.join(dir, `${n}.cmd`))
          ) {
            return false;
          }
        }
        return true;
      })
      .join(path.delimiter);
  }

  it("returns the expected check ids and exits 1 on an unwritable state dir", async () => {
    process.env.PATH = pathWithoutAgentBins();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-doctor-"));
    const state = path.join(root, "state");
    fs.mkdirSync(state, { recursive: true });
    fs.chmodSync(state, 0o500);
    let blocked = state;
    try {
      fs.mkdirSync(path.join(state, "probe-write"));
      // chmod did not take (typical on Windows); a file cannot be a state dir
      blocked = path.join(root, "blocked-file");
      fs.writeFileSync(blocked, "not-a-directory");
    } catch {
      // directory is not writable — the intended case
    }
    process.env.CCB_STATE_DIR = blocked;
    cleanups.push(() => {
      try {
        fs.chmodSync(state, 0o700);
      } catch {
        /* ignore */
      }
      fs.rmSync(root, { recursive: true, force: true });
    });

    const result = await runDoctor({ repoRoot: root, json: true });
    const ids = result.checks.map((c) => c.id);
    for (const id of [
      "node.version",
      "bridge.version",
      "git.version",
      "codex.cli",
      "codex.mcp-registration",
      "cursor.cli",
      "state.jobs-dir",
    ]) {
      expect(ids).toContain(id);
    }
    const jobsDirCheck = result.checks.find((c) => c.id === "state.jobs-dir");
    expect(jobsDirCheck?.status).toBe("fail");
    expect(result.exitCode).toBe(1);
  }, 30_000);
});
