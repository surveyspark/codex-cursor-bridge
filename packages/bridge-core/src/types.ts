/**
 * Core domain types for codex-cursor-bridge.
 *
 * These types are shared by every package: job records, results, handoff
 * plans, configuration, and start-request payloads. They mirror the JSON
 * Schemas in `schemas/` and are validated at runtime by `bridge-core/schemas`.
 */

export const BRIDGE_VERSION = "0.1.0" as const;

export type Host = "cursor" | "codex";
export type OriginHost = Host | "cli";
export type TargetHost = Host;

export type DelegationMode =
  | "investigate"
  | "review"
  | "adversarial-review"
  | "rescue"
  | "plan"
  | "implement";

export type PermissionProfile =
  | "read-only"
  | "isolated-workspace-write"
  | "current-workspace-write";

export type JobStatus =
  | "queued"
  | "starting"
  | "running"
  | "waiting-for-approval"
  | "waiting-for-input"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed-out";

export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed-out",
]);

export type AdapterName =
  | "codex-app-server"
  | "codex-exec-fallback"
  | "cursor-sdk"
  | "cursor-acp"
  | "cursor-cli-fallback";

export type NetworkPolicy = "denied" | "allowed";

export interface StartRequest {
  /** The task prompt given to the delegated agent. */
  task: string;
  /** Working directory / repository root for the job. */
  cwd: string;
  mode: DelegationMode;
  permissionProfile: PermissionProfile;
  /** Run in the background and return immediately with a queued job. */
  background: boolean;
  /** Optional model override. Never filled in by the bridge itself. */
  model?: string;
  /** Optional reasoning effort. */
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  /** Base git reference for worktree creation (branch, tag, or commit). */
  baseRef?: string;
  /** Worktree isolation preference: "auto" uses the permission profile default. */
  worktreePreference?: "auto" | "worktree" | "current";
  timeoutMs?: number;
  /** Origin metadata for recursion control and auditing. */
  origin?: {
    host: OriginHost;
    requestId?: string;
    parentJobId?: string;
    handoffDepth: number;
    maxHandoffDepth: number;
  };
  /** Relevant constraints the delegated agent must respect. */
  constraints?: string[];
  /** Expected output description. */
  expectedOutput?: string;
}

export interface DiffStat {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface ChangedFile {
  path: string;
  change: "added" | "modified" | "deleted" | "renamed";
}

export interface ApprovalRecord {
  ts: string;
  kind: string;
  summary?: string;
  decision: "approved" | "denied" | "timed-out" | "auto-denied";
  reason?: string;
}

export interface Continuation {
  supported: boolean;
  how: string;
}

export interface JobResult {
  jobId: string;
  nativeId: string | null;
  adapter: AdapterName;
  status: "completed" | "failed" | "cancelled" | "timed-out";
  summary: string;
  findings?: string[];
  changedFiles?: ChangedFile[];
  diffStat?: DiffStat | null;
  diffPatchPath?: string | null;
  commands?: Array<{
    command: string;
    exitCode?: number | null;
    aggregatedStatus?: "success" | "failure" | "unknown";
  }>;
  tests?: Array<{
    name: string;
    outcome: "passed" | "failed" | "skipped" | "unknown";
    detail?: string;
  }>;
  approvals?: ApprovalRecord[];
  warnings?: string[];
  blockers?: string[];
  residualRisks?: string[];
  artifacts?: Array<{ path: string; kind: "patch" | "log" | "plan" | "report" | "other" }>;
  continuation: Continuation;
  startedAt?: string | null;
  finishedAt?: string | null;
  failure?: {
    code: string;
    message: string;
    retriable: boolean;
  } | null;
}

export interface JobEvent {
  ts: string;
  type: string;
  level?: "debug" | "info" | "warn" | "error";
  data?: unknown;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseRef: string;
  created: boolean;
}

export interface RetentionPolicy {
  deleteAfter?: string | null;
  keepResult?: boolean;
}

export interface JobRecord {
  schemaVersion: "1.0";
  jobId: string;
  parentJobId?: string | null;
  originHost: OriginHost;
  targetHost: TargetHost;
  adapter: AdapterName;
  nativeId?: string | null;
  mode: DelegationMode;
  permissionProfile: PermissionProfile;
  handoffDepth: number;
  maxHandoffDepth: number;
  origin?: {
    requestId?: string | null;
    tool?: string | null;
    client?: string | null;
  };
  repoRoot: string;
  cwd: string;
  worktree?: WorktreeInfo | null;
  task: string;
  status: JobStatus;
  exitCode?: number | null;
  pid?: number | null;
  pidHostBootId?: string | null;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  updatedAt: string;
  timeoutMs?: number | null;
  deadlineAt?: string | null;
  retention?: RetentionPolicy;
  events: JobEvent[];
  eventsTruncated?: boolean;
  result?: JobResult | null;
  followUps?: Array<{
    ts: string;
    message: string;
    accepted?: boolean;
    note?: string;
  }>;
  approvals?: ApprovalRecord[];
}

export interface PlannedStep {
  id: string;
  description: string;
  rationale: string;
  likelyFiles?: string[];
  dependsOn?: string[];
  verification: string[];
}

export interface HandoffPlan {
  schemaVersion: "1.0";
  task: string;
  goal: string;
  nonGoals?: string[];
  observedRepositoryFacts: Array<{
    fact: string;
    evidence: string[];
  }>;
  assumptions?: string[];
  constraints?: string[];
  implementationSteps: PlannedStep[];
  acceptanceCriteria: string[];
  testPlan?: string[];
  risks?: Array<{ risk: string; mitigation: string }>;
  rollbackPlan?: string[];
  allowedPaths: string[];
  forbiddenActions?: string[];
  plannerSummary: string;
  generatedBy?: string;
  generatedAt?: string;
}

export interface BridgeConfig {
  schemaVersion: "1.0";
  preferredCursorAdapter: "auto" | "sdk" | "acp" | "cli-fallback";
  codexBinaryPath?: string;
  cursorBinaryPath?: string;
  defaultTimeoutMs: number;
  maxConcurrency: number;
  jobRetentionDays: number;
  completedRetentionDays: number;
  worktreeRoot?: string;
  defaultPermissionProfile: PermissionProfile;
  defaultImplementProfile: "isolated-workspace-write" | "current-workspace-write";
  defaultModel?: string | null;
  defaultReasoningEffort?: "low" | "medium" | "high" | "xhigh" | null;
  networkPolicy: NetworkPolicy;
  debugLogging: boolean;
  maxOutputBytes: number;
  autoReviewAfterExecution: boolean;
  autoCorrectionPass: boolean;
  allowNonInteractiveCliFallback: boolean;
  maxHandoffDepth: 0 | 1 | 2;
  approvalTimeoutMs: number;
}

export const DEFAULT_CONFIG: BridgeConfig = {
  schemaVersion: "1.0",
  preferredCursorAdapter: "auto",
  defaultTimeoutMs: 30 * 60 * 1000,
  maxConcurrency: 2,
  jobRetentionDays: 14,
  completedRetentionDays: 7,
  defaultPermissionProfile: "read-only",
  defaultImplementProfile: "isolated-workspace-write",
  defaultModel: null,
  defaultReasoningEffort: null,
  networkPolicy: "denied",
  debugLogging: false,
  maxOutputBytes: 2_000_000,
  autoReviewAfterExecution: false,
  autoCorrectionPass: false,
  allowNonInteractiveCliFallback: false,
  maxHandoffDepth: 1,
  approvalTimeoutMs: 120_000,
};
