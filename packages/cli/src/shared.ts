import { fileURLToPath, pathToFileURL } from "node:url";

export {
  BRIDGE_VERSION,
  loadConfig,
  jobsDir,
  stateRoot,
  logsDir,
  defaultWorktreeRoot,
  canonicalize,
  redactString,
} from "@codex-cursor-bridge/bridge-core";

/**
 * True when this module is the process entrypoint. Compares resolved
 * file URLs and treats `\\` and `/` as equivalent so Windows argv[1]
 * (backslash paths) still matches `import.meta.url`.
 */
export function isCliEntrypoint(
  metaUrl: string,
  argv1: string | undefined,
): boolean {
  if (!argv1) return false;
  try {
    const metaPath = fileURLToPath(metaUrl).replace(/\\/g, "/");
    const argvPath = argv1.replace(/\\/g, "/");
    if (metaPath === argvPath) return true;
    return metaUrl === pathToFileURL(argv1).href;
  } catch {
    return false;
  }
}
