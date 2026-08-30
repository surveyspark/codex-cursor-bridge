/**
 * Common adapter interfaces.
 *
 * Both host adapters (Codex, Cursor) implement `AgentAdapter`, producing
 * normalized events and results regardless of the underlying transport.
 */

import type {
  AdapterName,
  ApprovalRecord,
  DelegationMode,
  JobEvent,
  JobResult,
  PermissionProfile,
  StartRequest,
} from "@codex-cursor-bridge/bridge-core";

export interface AdapterEventContext {
  /** Record a normalized event (bridge persists it on the job). */
  emit(event: Omit<JobEvent, "ts">): void;
  /** Record an approval decision. */
  approval(record: ApprovalRecord): void;
}

export interface AdapterRunContext extends AdapterEventContext {
  jobId: string;
  cwd: string;
  /** Abort signal for cancellation/timeout. */
  abortSignal: AbortSignal;
  /** Called when the native session/agent id becomes known. */
  onNativeId(nativeId: string): void;
  /** Resolved configuration values the adapter may need. */
  debugLogging: boolean;
  networkPolicy: "denied" | "allowed";
  maxOutputBytes: number;
}

export interface AgentAdapter {
  readonly name: AdapterName;
  /** Whether this adapter is usable on this machine right now. */
  isAvailable(): Promise<AdapterAvailability>;
  /**
   * Run a delegated task and resolve with the final normalized result.
   * Implementations must respect ctx.abortSignal and emit progress events.
   */
  run(request: StartRequest, ctx: AdapterRunContext): Promise<JobResult>;
  /**
   * Send a follow-up message to an existing native session.
   * Returns false when the adapter cannot continue that session.
   */
  reply?(nativeId: string, message: string, ctx: AdapterRunContext): Promise<JobResult>;
  /** Terminate a running native session when supported. */
  cancel?(nativeId: string): Promise<boolean>;
  /** Capability description for doctor output. */
  describeCapabilities(): AdapterCapabilities;
}

export interface AdapterAvailability {
  available: boolean;
  reason?: string;
  version?: string;
}

export interface AdapterCapabilities {
  nativeId: "thread" | "session" | "agent" | "none";
  continuation: boolean;
  structuredEvents: boolean;
  approvals: "none" | "relayed" | "auto-denied";
  sandboxProfiles: PermissionProfile[];
  modes: DelegationMode[];
}

export function permissionProfileSandbox(
  profile: PermissionProfile,
): { sandbox: string; notes: string[] } {
  if (profile === "read-only") {
    return { sandbox: "read-only", notes: ["agent runs with read-only filesystem sandbox"] };
  }
  if (profile === "isolated-workspace-write") {
    return {
      sandbox: "workspace-write",
      notes: ["agent runs with workspace-write inside an isolated git worktree"],
    };
  }
  return {
    sandbox: "workspace-write",
    notes: ["agent runs with workspace-write directly in the current working tree"],
  };
}
