/**
 * Cursor SDK adapter (@cursor/sdk, server-side cloud/local agents API).
 *
 * The SDK is treated as an optional peer dependency: this module never hard-
 * imports it. Capability detection uses dynamic import and runtime checks so
 * the bridge works without the SDK installed. No model identifiers are hard-
 * coded. The CURSOR_API_KEY is consumed by the SDK itself from the
 * environment; the bridge never logs it.
 *
 * If the installed SDK's API surface differs from what we call, we fail with
 * ADAPTER_UNSUPPORTED_CAPABILITY and the selector falls back to ACP.
 */

import { BridgeError } from "@codex-cursor-bridge/bridge-core";
import type { JobResult, StartRequest } from "@codex-cursor-bridge/bridge-core";
import type {
  AdapterAvailability,
  AdapterCapabilities,
  AdapterRunContext,
  AgentAdapter,
} from "./types.js";
import { buildTaskPrompt } from "./prompt.js";

/* Minimal structural typing over @cursor/sdk's exported surface.
   Field names are verified at runtime; mismatches raise
   ADAPTER_UNSUPPORTED_CAPABILITY rather than crashing. */
interface SdkAgentLike {
  id?: string | { toString(): string };
  on?(event: string, handler: (data: unknown) => void): unknown;
  waitFor?(condition?: unknown): Promise<unknown>;
  stop?(): Promise<unknown>;
  followUp?(message: string): Promise<unknown> | unknown;
  status?: unknown;
  text?: unknown;
  messages?: unknown;
}

interface SdkModule {
  Agent?: new (opts: unknown) => SdkAgentLike;
  [k: string]: unknown;
}

export class CursorSdkAdapter implements AgentAdapter {
  readonly name = "cursor-sdk" as const;

  async isAvailable(): Promise<AdapterAvailability> {
    if (!process.env.CURSOR_API_KEY) {
      return {
        available: false,
        reason: "CURSOR_API_KEY is not set (required by @cursor/sdk)",
      };
    }
    const mod = await this.tryImport();
    if (!mod) {
      return {
        available: false,
        reason: "@cursor/sdk is not installed (npm i @cursor/sdk)",
      };
    }
    if (typeof mod.Agent !== "function") {
      return {
        available: false,
        reason: "@cursor/sdk found but its Agent export is missing/changed",
      };
    }
    return { available: true, version: "sdk" };
  }

  private async tryImport(): Promise<SdkModule | null> {
    try {
      // Dynamic import keeps the SDK optional.
      const modName = "@cursor/sdk";
      return (await import(/* @vite-ignore */ modName)) as SdkModule;
    } catch {
      return null;
    }
  }

  describeCapabilities(): AdapterCapabilities {
    return {
      nativeId: "agent",
      continuation: true,
      structuredEvents: true,
      approvals: "none",
      sandboxProfiles: [
        "read-only",
        "isolated-workspace-write",
        "current-workspace-write",
      ],
      modes: [
        "investigate",
        "review",
        "adversarial-review",
        "rescue",
        "plan",
        "implement",
      ],
    };
  }

  async run(request: StartRequest, ctx: AdapterRunContext): Promise<JobResult> {
    const startedAt = new Date().toISOString();
    const mod = await this.tryImport();
    if (!mod?.Agent) {
      throw new BridgeError(
        "ADAPTER_UNSUPPORTED_CAPABILITY",
        "@cursor/sdk Agent export unavailable",
      );
    }
    const AgentCtor = mod.Agent;

    // Runtime capability sniffing: inspect constructor parameter names /
    // defaults is brittle; instead we pass only documented core options and
    // let the SDK validate. The SDK owns authentication via CURSOR_API_KEY.
    const agentOpts: Record<string, unknown> = {
      prompt: { text: buildTaskPrompt(request, "cursor") },
      workingDirectory: ctx.cwd,
    };
    if (request.permissionProfile !== "read-only") {
      agentOpts.openInCursorAfterCompletion = false;
    }
    let agent: SdkAgentLike;
    try {
      agent = new (AgentCtor as new (o: unknown) => SdkAgentLike)(agentOpts);
    } catch (err) {
      throw new BridgeError(
        "ADAPTER_UNSUPPORTED_CAPABILITY",
        `@cursor/sdk Agent constructor rejected our options: ${(err as Error).message}`,
        {
          cause: err,
        },
      );
    }

    const nativeId =
      typeof agent.id === "string"
        ? agent.id
        : agent.id &&
            typeof (agent.id as { toString(): string }).toString === "function"
          ? String(agent.id)
          : null;
    if (nativeId) ctx.onNativeId(nativeId);
    else
      ctx.emit({
        type: "cursor.warn",
        level: "warn",
        data: { message: "SDK agent did not expose an id" },
      });

    // Stream structured events when supported.
    if (typeof agent.on === "function") {
      try {
        agent.on("status", (data) =>
          ctx.emit({
            type: "cursor.status",
            data: { status: safeStringify(data) },
          }),
        );
        agent.on("message", (data) =>
          ctx.emit({
            type: "cursor.message",
            data: { preview: safeStringify(data).slice(0, 2000) },
          }),
        );
      } catch {
        // Event subscription differences are non-fatal.
      }
    }

    const abortHandler = (): void => {
      agent
        .stop?.()
        .catch(() => {})
        ?.finally?.(() => {});
      if (agent.stop && !agent.waitFor) {
        // Older surfaces: fire-and-forget stop.
        void Promise.resolve(agent.stop()).catch(() => {});
      }
    };
    if (ctx.abortSignal.aborted) abortHandler();
    else
      ctx.abortSignal.addEventListener("abort", abortHandler, { once: true });

    let finalStatus: unknown;
    try {
      if (typeof agent.waitFor === "function") {
        finalStatus = await agent.waitFor();
      } else if (
        typeof (agent as { done?: Promise<unknown> }).done === "object"
      ) {
        await (agent as { done: Promise<unknown> }).done;
      } else {
        throw new BridgeError(
          "ADAPTER_UNSUPPORTED_CAPABILITY",
          "SDK agent exposes neither waitFor() nor done",
        );
      }
    } catch (err) {
      if (ctx.abortSignal.aborted) {
        return {
          jobId: ctx.jobId,
          nativeId,
          adapter: this.name,
          status: "cancelled",
          summary: "Cursor SDK agent run cancelled.",
          continuation: continuationFor(nativeId),
          startedAt,
          finishedAt: new Date().toISOString(),
          failure: {
            code: "JOB_CANCELLED",
            message: "aborted",
            retriable: true,
          },
        };
      }
      throw err;
    }

    const text = extractFinalText(agent, finalStatus);
    return {
      jobId: ctx.jobId,
      nativeId,
      adapter: this.name,
      status: "completed",
      summary:
        text.slice(0, 10_000) || "(cursor agent finished without final text)",
      continuation: continuationFor(nativeId),
      startedAt,
      finishedAt: new Date().toISOString(),
      failure: null,
    };
  }

  async reply(
    nativeId: string,
    message: string,
    ctx: AdapterRunContext,
  ): Promise<JobResult> {
    const mod = await this.tryImport();
    if (!mod?.Agent) {
      throw new BridgeError(
        "ADAPTER_UNSUPPORTED_CAPABILITY",
        "@cursor/sdk Agent export unavailable",
      );
    }
    const startedAt = new Date().toISOString();
    // Construct a handle to the existing agent by id when the SDK supports it.
    const AgentCtor = mod.Agent as new (o: unknown) => SdkAgentLike;
    let agent: SdkAgentLike | null = null;
    try {
      agent = new AgentCtor({ id: nativeId });
    } catch {
      agent = null;
    }
    if (!agent || typeof agent.followUp !== "function") {
      throw new BridgeError(
        "ADAPTER_UNSUPPORTED_CAPABILITY",
        "installed @cursor/sdk does not support attaching to an existing agent id for follow-up",
      );
    }
    await agent.followUp(message);
    if (typeof agent.waitFor === "function") await agent.waitFor();
    return {
      jobId: ctx.jobId,
      nativeId,
      adapter: this.name,
      status: "completed",
      summary:
        extractFinalText(agent, agent.status).slice(0, 10_000) ||
        "(follow-up completed)",
      continuation: continuationFor(nativeId),
      startedAt,
      finishedAt: new Date().toISOString(),
      failure: null,
    };
  }

  async cancel(nativeId: string): Promise<boolean> {
    const mod = await this.tryImport();
    if (!mod?.Agent) return false;
    try {
      const AgentCtor = mod.Agent as new (o: unknown) => SdkAgentLike;
      const agent = new AgentCtor({ id: nativeId });
      if (typeof agent.stop === "function") {
        await agent.stop();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }
}

function continuationFor(nativeId: string | null): {
  supported: boolean;
  how: string;
} {
  return nativeId
    ? {
        supported: true,
        how: `cursor_reply with nativeId=${nativeId} (SDK follow-up)`,
      }
    : { supported: false, how: "no agent id was returned by the SDK" };
}

function extractFinalText(agent: SdkAgentLike, finalStatus: unknown): string {
  if (typeof agent.text === "string" && agent.text.length > 0)
    return agent.text;
  if (Array.isArray(agent.messages)) {
    const last = [...(agent.messages as unknown[])].reverse().find((m) => {
      const rec = m as { role?: string; text?: string; content?: unknown };
      return rec && (rec.role === "assistant" || rec.role === "agent");
    }) as { text?: string } | undefined;
    if (last && typeof last.text === "string") return last.text;
  }
  return safeStringify(finalStatus ?? "");
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === "string" ? v : (JSON.stringify(v) ?? String(v));
  } catch {
    return String(v);
  }
}
