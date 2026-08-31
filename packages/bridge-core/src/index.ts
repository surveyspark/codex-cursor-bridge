import * as types from "./types.js";
import * as errors from "./errors.js";
import * as validate from "./validate.js";
import * as redact from "./redact.js";
import * as paths from "./paths.js";
import * as proc from "./process.js";
import * as jsonrpc from "./jsonrpc.js";
import * as config from "./config.js";
import * as logger from "./logger.js";

export const { BRIDGE_VERSION, TERMINAL_JOB_STATUSES, DEFAULT_CONFIG } = types;
export type {
  Host,
  OriginHost,
  TargetHost,
  DelegationMode,
  PermissionProfile,
  JobStatus,
  AdapterName,
  NetworkPolicy,
  StartRequest,
  DiffStat,
  ChangedFile,
  ApprovalRecord,
  Continuation,
  JobResult,
  JobEvent,
  WorktreeInfo,
  RetentionPolicy,
  JobRecord,
  PlannedStep,
  HandoffPlan,
  BridgeConfig,
} from "./types.js";

export { BridgeError, isBridgeError, asBridgeError } from "./errors.js";
export type { ErrorCode } from "./errors.js";

export {
  validateHandoffPlan,
  validateJobResult,
  validateStartRequest,
  planValidationError,
} from "./validate.js";
export type { ValidationIssue, ValidationResult } from "./validate.js";

export {
  redactSecrets,
  redactString,
  redactDeep,
  isSecretEnvName,
} from "./redact.js";

export {
  canonicalize,
  isInside,
  assertInsideRepo,
  assertRepoRelative,
  assertNoSymlinkEscape,
  worktreeDirName,
  sanitizeBranchName,
} from "./paths.js";

export { spawnProcess, buildChildEnv, isPidAlive } from "./process.js";
export {
  resolveCursorCliName,
  resetCursorCliCache,
  CURSOR_CLI_INSTALL_HINT,
} from "./cursor-cli.js";
export type { CursorCliName } from "./cursor-cli.js";
export type { SpawnOptions, SpawnOutcome, SpawnHandle } from "./process.js";

export {
  JsonLineReader,
  JsonRpcConnection,
  isRequest,
  isNotification,
  isResponse,
} from "./jsonrpc.js";
export type {
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
  JsonRpcMessage,
} from "./jsonrpc.js";

export {
  loadConfig,
  userConfigPath,
  projectConfigPath,
  stateRoot,
  jobsDir,
  logsDir,
  defaultWorktreeRoot,
  redactedConfig,
} from "./config.js";
export type { LoadedConfig } from "./config.js";

export { createLogger, getNullLogger } from "./logger.js";
export type { Logger, LogLevel, CreateLoggerOptions } from "./logger.js";

export const __modules = {
  types,
  errors,
  validate,
  redact,
  paths,
  process: proc,
  jsonrpc,
  config,
  logger,
};
void __modules;
