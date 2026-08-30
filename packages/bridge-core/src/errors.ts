/**
 * Typed errors with stable machine-readable codes.
 */

export type ErrorCode =
  | "BRIDGE_INTERNAL"
  | "BRIDGE_CONFIG_INVALID"
  | "BRIDGE_USAGE"
  | "BRIDGE_NOT_SUPPORTED"
  | "JOB_NOT_FOUND"
  | "JOB_INVALID_TRANSITION"
  | "JOB_ALREADY_TERMINAL"
  | "JOB_TIMEOUT"
  | "JOB_CANCELLED"
  | "JOB_LOCKED"
  | "JOB_STATE_CORRUPT"
  | "ADAPTER_NOT_AVAILABLE"
  | "ADAPTER_INIT_FAILED"
  | "ADAPTER_SPAWN_FAILED"
  | "ADAPTER_PROTOCOL_ERROR"
  | "ADAPTER_UNSUPPORTED_CAPABILITY"
  | "ADAPTER_TIMEOUT"
  | "ADAPTER_UNAUTHENTICATED"
  | "PLAN_INVALID"
  | "PATH_OUTSIDE_REPOSITORY"
  | "PATH_ESCAPE"
  | "WORKTREE_EXISTS"
  | "WORKTREE_CREATE_FAILED"
  | "GIT_UNAVAILABLE"
  | "RECURSION_BLOCKED"
  | "PERMISSION_DENIED"
  | "APPROVAL_DENIED"
  | "REDACTION_FAILED"
  | "CHILD_EXITED"
  | "SCHEMA_INVALID";

const KNOWN: ReadonlySet<string> = new Set([
  "BRIDGE_INTERNAL",
  "BRIDGE_CONFIG_INVALID",
  "BRIDGE_USAGE",
  "BRIDGE_NOT_SUPPORTED",
  "JOB_NOT_FOUND",
  "JOB_INVALID_TRANSITION",
  "JOB_ALREADY_TERMINAL",
  "JOB_TIMEOUT",
  "JOB_CANCELLED",
  "JOB_LOCKED",
  "JOB_STATE_CORRUPT",
  "ADAPTER_NOT_AVAILABLE",
  "ADAPTER_INIT_FAILED",
  "ADAPTER_SPAWN_FAILED",
  "ADAPTER_PROTOCOL_ERROR",
  "ADAPTER_UNSUPPORTED_CAPABILITY",
  "ADAPTER_TIMEOUT",
  "ADAPTER_UNAUTHENTICATED",
  "PLAN_INVALID",
  "PATH_OUTSIDE_REPOSITORY",
  "PATH_ESCAPE",
  "WORKTREE_EXISTS",
  "WORKTREE_CREATE_FAILED",
  "GIT_UNAVAILABLE",
  "RECURSION_BLOCKED",
  "PERMISSION_DENIED",
  "APPROVAL_DENIED",
  "REDACTION_FAILED",
  "CHILD_EXITED",
  "SCHEMA_INVALID",
]);

export class BridgeError extends Error {
  readonly code: ErrorCode;
  readonly retriable: boolean;
  readonly details?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { retriable?: boolean; cause?: unknown; details?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "BridgeError";
    this.code = code;
    this.retriable = opts.retriable ?? false;
    this.details = opts.details;
  }
}

export function isBridgeError(err: unknown): err is BridgeError {
  return err instanceof BridgeError;
}

export function assertErrorCode(code: string): asserts code is ErrorCode {
  if (!KNOWN.has(code)) {
    throw new BridgeError("BRIDGE_INTERNAL", `Unknown error code: ${code}`);
  }
}

export function toErrorCode(code: string): ErrorCode {
  if (KNOWN.has(code)) return code as ErrorCode;
  return "BRIDGE_INTERNAL";
}

/** Format an unknown thrown value into a stable error. */
export function asBridgeError(err: unknown): BridgeError {
  if (err instanceof BridgeError) return err;
  if (err instanceof Error) {
    return new BridgeError("BRIDGE_INTERNAL", err.message, { cause: err });
  }
  return new BridgeError("BRIDGE_INTERNAL", String(err));
}
