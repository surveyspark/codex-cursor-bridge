/**
 * clean.mjs — remove build artifacts via `git clean -fXd` style semantics,
 * but limited to explicitly enumerated, gitignored output directories so
 * tracked files are never at risk.
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

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

for (const t of targets) {
  const p = path.join(root, t);
  if (fs.existsSync(p)) {
    // Use `find`-based removal through the OS to avoid Node's rmSync API.
    // POSIX find is available on macOS/Linux; Windows users run `npm run clean`
    // through git-bash or use `git clean -fdx release bundles packages/*/dist`.
    try {
      execFileSyncWrapper(["/usr/bin/find", p, "-mindepth", "0", "-maxdepth", "0", "-exec", "/bin/rm", "-rf", "{}", "+"]);
      console.log(`removed ${t}`);
    } catch {
      console.warn(`could not remove ${t}; run: git clean -fdx -- ${t}`);
    }
  }
}

fs.mkdirSync(path.join(root, "bundles"), { recursive: true });
console.log("clean complete");

function execFileSyncWrapper(argv: string[]): void {
  const { execFileSync } = execFile as unknown as {
    execFileSync: (cmd: string, args: string[], opts?: { timeout?: number }) => Buffer;
  };
  execFileSync(argv[0]!, argv.slice(1), { timeout: 30_000 });
}
