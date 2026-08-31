/**
 * Cursor adapter selection: sdk → acp → cli-fallback.
 *
 * Verified against official docs (cursor.com/docs/cli/*, cursor.com/docs/reference/plugins)
 * and npm registry (@cursor/sdk 1.0.30, cursor-agent 1.0.3):
 *
 * - `@cursor/sdk` requires CURSOR_API_KEY (server-side agents API). The SDK
 *   is an optional peer dependency; the adapter is only selected when the
 *   package can be imported AND the key is present (never logged).
 * - `cursor-agent acp` runs the Cursor CLI as an ACP server over stdio with
 *   JSON-RPC messaging (Agent Client Protocol). Session ids are preserved;
 *   permission requests are relayed, not auto-approved.
 * - `cursor-agent -p/--print` non-interactive mode has FULL WRITE ACCESS to
 *   the machine ("Cursor has full write access in non-interactive mode" per
 *   official docs). It is therefore gated behind explicit opt-in
 *   (--allow-noninteractive-cli / allowNonInteractiveCliFallback) and a
 *   prominent warning, and combined with the bridge's read-only intent the
 *   bridge adds explicit constraints in the prompt. This is the last resort.
 */

import { BridgeError } from "@codex-cursor-bridge/bridge-core";
import type { BridgeConfig } from "@codex-cursor-bridge/bridge-core";
import type { AdapterAvailability, AgentAdapter } from "./types.js";
import { CursorSdkAdapter } from "./sdk.js";
import { CursorAcpAdapter } from "./acp.js";
import { CursorCliFallbackAdapter } from "./cli-fallback.js";

export interface CursorAdapterSetOptions {
  config: BridgeConfig;
  cursorBinaryPath?: string;
  /** Test hook: inject adapters directly. */
  overrides?: Partial<Record<"sdk" | "acp" | "cli-fallback", AgentAdapter>>;
}

export async function selectCursorAdapter(
  opts: CursorAdapterSetOptions,
): Promise<{
  adapter: AgentAdapter;
  selectionReason: string;
  allStatuses: Record<string, AdapterAvailability>;
}> {
  const statuses: Record<string, AdapterAvailability> = {};
  const preferred = opts.config.preferredCursorAdapter;

  const candidates: Array<{
    key: "sdk" | "acp" | "cli-fallback";
    make: () => AgentAdapter;
  }> = [
    { key: "sdk", make: () => opts.overrides?.sdk ?? new CursorSdkAdapter() },
    {
      key: "acp",
      make: () =>
        opts.overrides?.acp ??
        new CursorAcpAdapter({
          ...(opts.cursorBinaryPath
            ? { cursorBinaryPath: opts.cursorBinaryPath }
            : {}),
        }),
    },
    {
      key: "cli-fallback",
      make: () =>
        opts.overrides?.["cli-fallback"] ??
        new CursorCliFallbackAdapter({
          ...(opts.cursorBinaryPath
            ? { cursorBinaryPath: opts.cursorBinaryPath }
            : {}),
          allowNonInteractive: opts.config.allowNonInteractiveCliFallback,
        }),
    },
  ];

  // Reorder when a specific adapter is preferred.
  const ordered =
    preferred === "auto"
      ? candidates
      : [
          ...candidates.filter((c) => c.key === preferred),
          ...candidates.filter((c) => c.key !== preferred),
        ];

  const probeCache = new Map<string, AdapterAvailability>();
  for (const candidate of ordered) {
    const adapter = candidate.make();
    let status = probeCache.get(candidate.key);
    if (!status) {
      status = await adapter.isAvailable();
      probeCache.set(candidate.key, status);
    }
    statuses[candidate.key] = status;

    if (candidate.key === "cli-fallback") {
      // Never auto-select the CLI fallback unless explicitly enabled.
      if (!opts.config.allowNonInteractiveCliFallback) {
        continue;
      }
    }
    if (candidate.key === "sdk" && preferred !== "sdk") {
      // SDK requires CURSOR_API_KEY; if missing, fall through to ACP unless
      // the user explicitly prefers sdk.
      if (!process.env.CURSOR_API_KEY) continue;
    }
    if (status.available) {
      const reason =
        preferred === "auto"
          ? `auto-selected (first available in order sdk → acp → cli-fallback)`
          : `preferred adapter "${preferred}"`;
      return { adapter, selectionReason: reason, allStatuses: statuses };
    }
    if (preferred === candidate.key) {
      // Explicit preference unavailable: report and stop.
      throw new BridgeError(
        "ADAPTER_NOT_AVAILABLE",
        `preferred cursor adapter "${preferred}" is unavailable: ${status.reason ?? "unknown reason"}`,
      );
    }
  }
  throw new BridgeError(
    "ADAPTER_NOT_AVAILABLE",
    "no Cursor adapter available (tried sdk, acp, cli-fallback)",
    {
      details: statuses,
    },
  );
}

export { CursorSdkAdapter } from "./sdk.js";
export { CursorAcpAdapter } from "./acp.js";
export { CursorCliFallbackAdapter } from "./cli-fallback.js";
export { buildTaskPrompt } from "./prompt.js";
export type {
  AdapterAvailability,
  AgentAdapter,
  AdapterCapabilities,
  AdapterRunContext,
} from "./types.js";
