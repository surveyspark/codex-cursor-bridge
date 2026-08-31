/**
 * Test helpers: re-export bridge-core from workspace sources and provide
 * small wrappers used across suites.
 */

export * from "@codex-cursor-bridge/bridge-core";
import { BridgeError, type JobStatus } from "@codex-cursor-bridge/bridge-core";
import { assertTransition } from "@codex-cursor-bridge/job-store";

export function assertTransitionSafe(from: JobStatus, to: JobStatus): void {
  try {
    assertTransition(from, to);
  } catch (err) {
    if (err instanceof BridgeError) throw new Error(err.message);
    throw err;
  }
}

export {
  JobStore,
  newJobId,
  assertTransition,
} from "@codex-cursor-bridge/job-store";
export {
  CodexAppServerAdapter,
  CodexExecAdapter,
  mapProfileToSandbox,
  buildTaskPrompt,
} from "@codex-cursor-bridge/codex-adapter";
export {
  CursorSdkAdapter,
  CursorAcpAdapter,
  CursorCliFallbackAdapter,
  selectCursorAdapter,
  buildTaskPrompt as buildCursorTaskPrompt,
} from "@codex-cursor-bridge/cursor-adapter";
export { JobManager, inspectGit } from "@codex-cursor-bridge/orchestrator";
export {
  fakeCodexAppServer,
  fakeCursorAcp,
  makeTempRepo,
  materializeFake,
  GIT_ENV,
  waitFor,
} from "@codex-cursor-bridge/test-support";
