export { JobManager } from "./job-manager.js";
export type {
  JobManagerOptions,
  StartJobOptions,
  StartJobResult,
} from "./job-manager.js";
export {
  createWorktree,
  removeWorktree,
  collectWorktreeDiff,
  collectCurrentDiffSummary,
  inspectGit,
  gitVersion,
} from "./worktree.js";
export type {
  WorktreeCreated,
  WorktreeDiffSummary,
  GitInfo,
} from "./worktree.js";
export { buildToolRouter, invokeToolSafe } from "./tools.js";
export type { ToolDef, ToolResult } from "./tools.js";
