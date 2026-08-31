/**
 * Config resolution re-exports for the orchestrator, decoupled so tests can
 * stub environment-dependent paths via CCB_STATE_DIR.
 */

export {
  jobsDir,
  logsDir,
  defaultWorktreeRoot,
  loadConfig,
} from "@codex-cursor-bridge/bridge-core";
export { DEFAULT_CONFIG } from "@codex-cursor-bridge/bridge-core";
