/**
 * Map bridge permission profiles to Codex sandbox/approval settings.
 *
 * Verified against codex-cli 0.145.0 schemas:
 * - SandboxMode (thread/start `sandbox`): "read-only" | "workspace-write" |
 *   "danger-full-access"
 * - SandboxPolicy (turn/start `sandboxPolicy`): { type: "readOnly",
 *   networkAccess?: boolean } | { type: "workspaceWrite", networkAccess?,
 *   writableRoots?, excludeSlashTmp?, excludeTmpdirEnvVar? } |
 *   { type: "dangerFullAccess" }
 * - AskForApproval: "untrusted" | "on-request" | "never" (+ experimental
 *   granular object form). The bridge always uses "never" and enforces its
 *   own policy via sandbox + worktree isolation; server approval requests
 *   are auto-denied by the bridge (defense in depth).
 *
 * danger-full-access is never produced by this mapping.
 */

import path from "node:path";
import type { PermissionProfile } from "@codex-cursor-bridge/bridge-core";

export interface CodexSandbox {
  /** thread/start sandbox value (SandboxMode string). */
  sandboxMode: "read-only" | "workspace-write";
  /** turn/start sandboxPolicy object (SandboxPolicy). */
  turnSandboxPolicy: Record<string, unknown>;
  notes: string[];
}

export function mapProfileToSandbox(
  profile: PermissionProfile,
  cwd: string,
  networkPolicy: "denied" | "allowed",
): CodexSandbox {
  if (profile === "read-only") {
    return {
      sandboxMode: "read-only",
      turnSandboxPolicy: {
        type: "readOnly",
        networkAccess: networkPolicy === "allowed",
      },
      notes: ["codex sandbox: read-only"],
    };
  }
  // Writable roots: the job working directory only (the worktree for
  // isolated profile). Never the filesystem root or the user's home.
  const writableRoots = [path.resolve(cwd)];
  const notes = [
    `codex sandbox: workspace-write with writable root ${writableRoots[0]!}`,
  ];
  return {
    sandboxMode: "workspace-write",
    turnSandboxPolicy: {
      type: "workspaceWrite",
      networkAccess: networkPolicy === "allowed",
      writableRoots,
    },
    notes,
  };
}
