/**
 * JSON Lines (NDJSON) protocol helpers for stdio transports.
 *
 * Handles incremental line buffering, maximum message sizes, malformed JSON
 * containment, and request-id correlation. Shared by the Codex app-server
 * adapter, Cursor ACP adapter, and fake test transports.
 */

import { BridgeError } from "./errors.js";

export interface JsonLineOptions {
  /** Maximum bytes for a single JSON line before treating it as a protocol error. */
  maxMessageBytes?: number;
  onMessage: (msg: unknown, raw: string) => void;
  onOversized?: (raw: string) => void;
  onMalformed?: (err: unknown, raw: string) => void;
}

/** Incremental NDJSON line reader with size and malformed-JSON safety. */
export class JsonLineReader {
  private pending = "";
  private readonly maxBytes: number;

  constructor(private readonly opts: JsonLineOptions) {
    this.maxBytes = opts.maxMessageBytes ?? 16 * 1024 * 1024;
  }

  push(chunk: string): void {
    // Accept both raw stream chunks and pre-split lines: a trailing newline
    // is optional, so single lines passed by line-splitters dispatch too.
    this.pending += chunk;
    let idx: number;
    while ((idx = this.pending.indexOf("\n")) >= 0) {
      const raw = this.pending.slice(0, idx).trim();
      this.pending = this.pending.slice(idx + 1);
      if (raw.length === 0) continue;
      this.dispatch(raw);
    }
    // No trailing newline: dispatch what we have (line-oriented transports).
    if (this.pending.trim().length > 0) {
      const raw = this.pending.trim();
      this.pending = "";
      this.dispatch(raw);
    }
    if (this.pending.length > this.maxBytes) {
      const raw = this.pending;
      this.pending = "";
      this.opts.onOversized?.(raw);
    }
  }

  /** Flush any trailing partial line (no newline at EOF). */
  end(): void {
    const raw = this.pending.trim();
    this.pending = "";
    if (raw.length > 0) this.dispatch(raw);
  }

  private dispatch(raw: string): void {
    if (raw.length > this.maxBytes) {
      this.opts.onOversized?.(raw);
      return;
    }
    try {
      const msg: unknown = JSON.parse(raw);
      this.opts.onMessage(msg, raw);
    } catch (err) {
      this.opts.onMalformed?.(err, raw);
    }
  }
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return "id" in msg && !("method" in msg);
}

export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "method" in msg && "id" in msg;
}

export function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return "method" in msg && !("id" in msg);
}

/**
 * Correlated JSON-RPC over NDJSON: send requests, route responses to
 * pending promise resolvers, dispatch notifications to a handler, and
 * surface server->client requests (e.g. approval prompts).
 */
export class JsonRpcConnection {
  private nextId = 1;
  private readonly pending = new Map<
    number | string,
    { resolve: (v: unknown) => void; reject: (e: BridgeError) => void; timer: NodeJS.Timeout | null }
  >();
  private closed = false;

  constructor(
    private readonly opts: {
      send: (line: string) => void;
      onNotification: (msg: JsonRpcNotification) => void;
      /** Server-initiated request (e.g. approval). Return the response result. */
      onServerRequest: (msg: JsonRpcRequest) => Promise<unknown>;
      requestTimeoutMs?: number;
      onMalformed?: (err: unknown) => void;
      onClose?: () => void;
    },
  ) {}

  handleLine(raw: string, reader: { push(chunk: string): void }): void {
    void reader;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(raw) as JsonRpcMessage;
    } catch (err) {
      this.opts.onMalformed?.(err);
      return;
    }
    if (typeof msg !== "object" || msg === null || !("jsonrpc" in msg)) {
      this.opts.onMalformed?.(new Error("not a JSON-RPC 2.0 message"));
      return;
    }
    if (isResponse(msg)) {
      const entry = this.pending.get(msg.id);
      if (!entry) return; // unknown id: ignore for forward compatibility
      this.pending.delete(msg.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(
          new BridgeError("ADAPTER_PROTOCOL_ERROR", `JSON-RPC error ${msg.error.code}: ${msg.error.message}`, {
            details: msg.error,
          }),
        );
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    if (isNotification(msg)) {
      this.opts.onNotification(msg);
      return;
    }
    // Server -> client request: answer, never throw into the read loop.
    const serverRequest = msg as JsonRpcRequest;
    void (async () => {
      try {
        const result = await this.opts.onServerRequest(serverRequest);
        this.sendRaw({ jsonrpc: "2.0", id: serverRequest.id, result: result ?? {} });
      } catch (err) {
        const be = err as { code?: number; message?: string };
        this.sendRaw({
          jsonrpc: "2.0",
          id: serverRequest.id,
          error: { code: be.code ?? -32603, message: be.message ?? "internal error" },
        });
      }
    })();
  }

  private sendRaw(obj: unknown): void {
    if (this.closed) return;
    try {
      this.opts.send(JSON.stringify(obj));
    } catch {
      // Transport died mid-write; waitExit/exit handling reports it.
      this.closed = true;
    }
  }

  notify(method: string, params?: unknown): void {
    const msg: JsonRpcNotification = { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) };
    this.sendRaw(msg);
  }

  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new BridgeError("ADAPTER_PROTOCOL_ERROR", "connection closed"));
    }
    const id = this.nextId++;
    const timeout = timeoutMs ?? this.opts.requestTimeoutMs ?? 120_000;
    return new Promise<unknown>((resolve, reject) => {
      const timer =
        timeout > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new BridgeError("ADAPTER_TIMEOUT", `request ${method} timed out after ${timeout}ms`));
            }, timeout)
          : null;
      this.pending.set(id, {
        resolve: (v) => { if (timer) clearTimeout(timer); resolve(v); },
        reject: (e) => { if (timer) clearTimeout(timer); reject(e); },
        timer,
      });
      this.sendRaw({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  /** Reject all pending requests and stop sending. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new BridgeError("ADAPTER_PROTOCOL_ERROR", "connection closed with request pending", { details: { id } }));
      this.pending.delete(id);
    }
    this.opts.onClose?.();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
