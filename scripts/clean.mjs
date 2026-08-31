/**
 * clean.mjs — remove build artifacts from explicitly enumerated, gitignored
 * output directories (never tracked files).
 *
 * Prefers `git clean -fxd -- <paths>` when git is available; otherwise falls
 * back to per-platform directory removal via shell built-ins.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const targets = [
  "release",
  "coverage",
  "packages/bridge-core/dist",
  "packages/job-store/dist",
  "packages/codex-adapter/dist",
  "packages/cursor-adapter/dist",
  "packages/orchestrator/dist",
  "packages/mcp-server/dist",
  "packages/cli/dist",
  "packages/test-support/dist",
  "bundles",
];

const existing = targets.filter((t) => fs.existsSync(path.join(root, t)));
if (existing.length === 0) {
  console.log("nothing to clean");
  process.exit(0);
}

try {
  await execFileAsync("git", ["clean", "-fxd", "--", ...existing], {
    cwd: root,
    timeout: 60_000,
  });
  console.log(`git clean removed: ${existing.join(", ")}`);
} catch {
  console.log(
    "git unavailable; run manually: git clean -fxd -- " + existing.join(" "),
  );
}

fs.mkdirSync(path.join(root, "bundles"), { recursive: true });
console.log("clean complete");
