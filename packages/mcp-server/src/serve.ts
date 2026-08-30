/**
 * MCP stdio server (JSON-RPC 2.0 over stdin/stdout, Model Context Protocol).
 *
 * Implementing the protocol directly (initialize, tools/list, tools/call)
 * keeps the bridge dependency-free: the wire format is the documented MCP
 * JSON-RPC surface used by both Cursor and Codex for local servers.
 *
 * CRITICAL: stdout carries ONLY JSON-RPC. All logging goes to stderr or the
 * state log file. The server is stdio-only; it never opens a port.
 */

import {
  JsonLineReader,
  BridgeError,
  asBridgeError,
  createLogger,
  canonicalize,
  redactString,
} from "@codex-cursor-bridge/bridge-core";
import { JobStore } from "@codex-cursor-bridge/job-store";
import { CodexAppServerAdapter, CodexExecAdapter } from "@codex-cursor-bridge/codex-adapter";
import { selectCursorAdapter } from "@codex-cursor-bridge/cursor-adapter";
import { JobManager, buildToolRouter, invokeToolSafe, type ToolDef } from "@codex-cursor-bridge/orchestrator";
import { loadConfig, jobsDir, stateRoot, BRIDGE_VERSION } from "./shared.js";

export interface ServeOptions {
  /** "cursor" exposes Codex tools; "codex" exposes Cursor tools. */
  host: "cursor" | "codex";
  repoRoot: string;
  /** Config overrides (CLI flags). */
  configOverrides?: Record<string, unknown>;
  logger?: ReturnType<typeof createLogger>;
}

interface PendingInit {
  protocolVersion: string | number;
  clientInfo?: { name?: string; version?: string };
}

export async function serveMcp(opts: ServeOptions): Promise<void> {
  const log =
    opts.logger ??
    createLogger({
      level: process.env.CCB_DEBUG ? "debug" : "info",
      filePath: `${stateRoot()}/logs/mcp-${opts.host}.log`,
    });

  const repoRoot = canonicalize(opts.repoRoot);
  const { config } = loadConfig(repoRoot, opts.configOverrides as never);

  // Crash recovery at startup: mark orphaned non-terminal jobs as failed.
  const store = new JobStore({ jobsDir: jobsDir() });
  const recovered = store.recover();
  if (recovered.length > 0) log.info(`recovered ${recovered.length} orphaned job(s)`, { jobIds: recovered });

  const manager = new JobManager({
    repoRoot,
    config,
    logger: log,
    selectAdapter: async (_request, record) => {
      if (record.targetHost === "codex") {
        const appServer = new CodexAppServerAdapter({ ...(config.codexBinaryPath ? { codexBinaryPath: config.codexBinaryPath } : {}) });
        const appServerStatus = await appServer.isAvailable();
        if (appServerStatus.available) {
          // Probe initialization readiness cheaply (also validates auth path).
          const probe = await appServer.probe();
          if (probe.ok) return { adapter: appServer, reason: "codex app-server initialize succeeded" };
          log.warn(`codex app-server probe failed, considering exec fallback`, { detail: probe.detail });
        }
        const fallback = new CodexExecAdapter({ ...(config.codexBinaryPath ? { codexBinaryPath: config.codexBinaryPath } : {}) });
        const fallbackStatus = await fallback.isAvailable();
        if (fallbackStatus.available) {
          return { adapter: fallback, reason: `codex exec fallback (${appServerStatus.reason ?? appServerStatus.available})` };
        }
        throw new BridgeError("ADAPTER_NOT_AVAILABLE", "no Codex adapter available", {
          details: { appServer: appServerStatus, exec: fallbackStatus },
        });
      }
      const selection = await selectCursorAdapter({
        config,
        ...(config.cursorBinaryPath ? { cursorBinaryPath: config.cursorBinaryPath } : {}),
      });
      log.info(`cursor adapter selected`, { reason: selection.selectionReason, statuses: selection.allStatuses });
      return { adapter: selection.adapter, reason: selection.selectionReason };
    },
  });

  const tools: ToolDef[] = buildToolRouter({
    originHost: opts.host === "cursor" ? "cursor" : "codex",
    prefix: opts.host === "cursor" ? "codex" : "cursor",
    manager,
  });

  const serverInfo = {
    name: opts.host === "cursor" ? "codex-cursor-bridge (Codex tools)" : "codex-cursor-bridge (Cursor tools)",
    version: BRIDGE_VERSION,
  };

  let initialized = false;

  const send = (obj: unknown): void => {
    process.stdout.write(JSON.stringify(obj) + "\n");
  };

  const reply = (id: unknown, result: unknown): void => send({ jsonrpc: "2.0", id, result });
  const replyError = (id: unknown, code: number, message: string): void =>
    send({ jsonrpc: "2.0", id, error: { code, message: redactString(message) } });

  const handleRequest = async (id: unknown, method: string, params: Record<string, unknown>): Promise<void> => {
    switch (method) {
      case "initialize": {
        const p = params as unknown as PendingInit;
        initialized = true;
        reply(id, {
          protocolVersion: typeof p.protocolVersion === "number" ? p.protocolVersion : "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo,
          instructions:
            opts.host === "cursor"
              ? "Bridge tools delegate work to Codex. Read-only modes are the default; implement mode writes to an isolated git worktree. Jobs preserve the native Codex thread id."
              : "Bridge tools delegate execution to Cursor. Provide a validated handoff plan; Cursor implements directly and reports deviations. Jobs preserve the native Cursor session id.",
        });
        return;
      }
      case "notifications/initialized":
        return; // notification, no response
      case "ping":
        reply(id, {});
        return;
      case "tools/list": {
        requireInit();
        reply(id, {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: { readOnlyHint: false, openWorldHint: false },
          })),
        });
        return;
      }
      case "tools/call": {
        requireInit();
        const name = String(params.name ?? "");
        const tool = tools.find((t) => t.name === name);
        if (!tool) {
          replyError(id, -32602, `unknown tool ${name}`);
          return;
        }
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        const outcome = await invokeToolSafe(tool, args);
        if (!outcome.ok) {
          reply(id, {
            content: [{ type: "text", text: `ERROR ${outcome.code}: ${outcome.message}` }],
            isError: true,
          });
          return;
        }
        reply(id, {
          content: [
            { type: "text", text: outcome.summary },
            { type: "text", text: "```json\n" + JSON.stringify(outcome.payload, null, 2).slice(0, 60_000) + "\n```" },
          ],
          structuredContent: outcome.payload as Record<string, unknown>,
        });
        return;
      }
      default:
        replyError(id, -32601, `method not supported: ${method}`);
    }
  };

  function requireInit(): void {
    if (!initialized) throw new BridgeError("BRIDGE_USAGE", "server not initialized");
  }

  const reader = new JsonLineReader({
    maxMessageBytes: 8 * 1024 * 1024,
    onMessage: (msg) => {
      void (async () => {
        const m = msg as { id?: unknown; method?: string; params?: Record<string, unknown> };
        if (!m || typeof m.method !== "string") return;
        try {
          await handleRequest(m.id, m.method, m.params ?? {});
        } catch (err) {
          const be = asBridgeError(err);
          if (m.id !== undefined && m.id !== null) {
            replyError(m.id, be.code === "BRIDGE_USAGE" ? -32602 : -32603, be.message);
          }
        }
      })();
    },
    onMalformed: (err) => log.warn(`malformed JSON on stdin`, { error: String(err) }),
  });

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => reader.push(chunk));
  process.stdin.on("end", () => {
    reader.end();
    process.exit(0);
  });
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));

  log.info(`mcp server listening on stdio`, { host: opts.host, tools: tools.map((t) => t.name) });
}
