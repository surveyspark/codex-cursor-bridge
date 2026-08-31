#!/usr/bin/env node
/**
 * Opt-in end-to-end tests against REAL installed products.
 *
 *   RUN_CODEX_E2E=1   — requires codex CLI + valid login
 *   RUN_CURSOR_E2E=1  — requires cursor-agent CLI + login (or CURSOR_API_KEY + @cursor/sdk)
 *
 * Uses a harmless temporary repository and a bounded, low-cost task per run.
 * Never runs in ordinary CI.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bin = path.join(root, "bundles/codex-cursor-bridge.mjs");

const results = { pass: [], fail: [], skipped: [] };

async function run(args, opts = {}) {
  const { stdout } = await execFileAsync(process.execPath, [bin, ...args], {
    timeout: opts.timeout ?? 10 * 60_000,
    encoding: "utf8",
    env: { ...process.env },
    cwd: opts.cwd ?? root,
  });
  return stdout;
}

function check(name, cond, detail = "") {
  if (cond) results.pass.push(name);
  else results.fail.push(`${name}${detail ? `: ${detail}` : ""}`);
}

async function codexE2E() {
  const { mkdtemp } = await import("node:fs/promises");
  const os = await import("node:os");
  const dir = await mkdtemp(path.join(os.tmpdir(), "ccb-e2e-codex-"));
  fs.writeFileSync(path.join(dir, "README.md"), "# e2e sandbox repo\n", { mode: 0o644 });
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: dir });
    await execFileAsync("git", ["add", "-A"], { cwd: dir });
    await execFileAsync("git", ["commit", "-qm", "init"], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.invalid", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.invalid" } });
  } catch {
    /* commit best effort */
  }

  const out = await run([
    "codex", "start",
    "--task", "Reply with exactly the word BRIDGE-E2E-OK and nothing else.",
    "--mode", "investigate",
    "--json",
  ], { cwd: dir, timeout: 8 * 60_000 });
  check("codex e2e: start returns JSON", out.includes('"status"'), out.slice(0, 200));
  check("codex e2e: completed", out.includes('"completed"'), out.slice(0, 300));
  check("codex e2e: native thread id captured", /"(thr_|[0-9a-f]{8}-[0-9a-f]{4})/.test(out) || /nativeId/.test(out), out.slice(0, 300));
}

async function cursorE2E() {
  const os = await import("node:os");
  const { mkdtemp } = await import("node:fs/promises");
  const dir = await mkdtemp(path.join(os.tmpdir(), "ccb-e2e-cursor-"));
  fs.writeFileSync(path.join(dir, "README.md"), "# e2e sandbox repo\n", { mode: 0o644 });
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: dir });
  } catch {
    /* best effort */
  }
  const out = await run([
    "cursor", "start",
    "--task", "Reply with exactly the word BRIDGE-E2E-OK and nothing else. Do not modify files.",
    "--mode", "investigate",
    "--json",
  ], { cwd: dir, timeout: 8 * 60_000 });
  check("cursor e2e: start returns JSON", out.includes('"status"'), out.slice(0, 200));
  check("cursor e2e: completed", out.includes('"completed"'), out.slice(0, 300));
}

async function main() {
  if (process.env.RUN_CODEX_E2E === "1") {
    try {
      await codexE2E();
    } catch (err) {
      results.fail.push(`codex e2e threw: ${err.message?.slice(0, 300)}`);
    }
  } else {
    results.skipped.push("codex e2e (set RUN_CODEX_E2E=1)");
  }

  if (process.env.RUN_CURSOR_E2E === "1") {
    try {
      await cursorE2E();
    } catch (err) {
      results.fail.push(`cursor e2e threw: ${err.message?.slice(0, 300)}`);
    }
  } else {
    results.skipped.push("cursor e2e (set RUN_CURSOR_E2E=1)");
  }

  for (const p of results.pass) console.log(`  PASS ${p}`);
  for (const s of results.skipped) console.log(`  SKIP ${s}`);
  for (const f of results.fail) console.error(`  FAIL ${f}`);
  process.exitCode = results.fail.length > 0 ? 1 : 0;
  if (results.skipped.length > 0) {
    console.log("\ncredential-dependent tests were SKIPPED (not run, not counted as passing).");
  }
}

main();
