/**
 * Resolve the official Cursor CLI binary name.
 *
 * Ground truth (cursor.com/docs/cli/installation, verified 2026-08-30): the
 * CLI is distributed ONLY via the installer script (`curl
 * https://cursor.com/install -fsS | bash`; Windows:
 * `irm 'https://cursor.com/install?win32=true' | iex`) and the binary is
 * **`agent`**. There is NO official npm package — the npm `cursor-agent`
 * package is an unrelated third-party project.
 *
 * The bridge therefore prefers `agent`, falls back to `cursor-agent` as a
 * legacy alias (some environments symlink it), and can be pinned explicitly
 * via config (cursorBinaryPath) or CCB_CURSOR_BINARY.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const CURSOR_CLI_INSTALL_HINT =
  "install the official Cursor CLI: curl https://cursor.com/install -fsS | bash (Windows: irm 'https://cursor.com/install?win32=true' | iex)";

export type CursorCliName = "agent" | "cursor-agent";

let cached: CursorCliName | null = null;
let cachedAt = 0;
const CACHE_MS = 60_000;

/** Probe PATH for the official `agent` binary first, then the legacy alias. */
export async function resolveCursorCliName(): Promise<CursorCliName> {
  if (cached && Date.now() - cachedAt < CACHE_MS) return cached;
  for (const name of ["agent", "cursor-agent"] as const) {
    try {
      await execFileAsync(name, ["--version"], { timeout: 5_000 });
      cached = name;
      cachedAt = Date.now();
      return name;
    } catch {
      // try next candidate
    }
  }
  cached = "agent";
  cachedAt = Date.now();
  return "agent";
}

export function resetCursorCliCache(): void {
  cached = null;
  cachedAt = 0;
}
