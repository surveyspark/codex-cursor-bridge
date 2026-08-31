/**
 * Shared adapter interfaces (Cursor side).
 * Mirrors packages/codex-adapter/src/types.ts.
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
  emit(event: Omit<JobEvent, "ts">): void;
  approval(record: ApprovalRecord): void;
}

export interface AdapterRunContext extends AdapterEventContext {
  jobId: string;
  cwd: string;
  abortSignal: AbortSignal;
  onNativeId(nativeId: string): void;
  debugLogging: boolean;
  networkPolicy: "denied" | "allowed";
  maxOutputBytes: number;
}

export interface AgentAdapter {
  readonly name: AdapterName;
  isAvailable(): Promise<AdapterAvailability>;
  run(request: StartRequest, ctx: AdapterRunContext): Promise<JobResult>;
  reply?(
    nativeId: string,
    message: string,
    ctx: AdapterRunContext,
  ): Promise<JobResult>;
  cancel?(nativeId: string): Promise<boolean>;
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
