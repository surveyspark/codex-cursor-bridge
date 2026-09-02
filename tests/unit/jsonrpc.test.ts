import { describe, expect, it } from "vitest";
import { JsonLineReader } from "../helpers.js";

describe("JsonLineReader incremental buffering", () => {
  it("retains a partial line across push() calls and dispatches once complete", () => {
    const messages: unknown[] = [];
    const malformed: string[] = [];
    const reader = new JsonLineReader({
      onMessage: (msg) => messages.push(msg),
      onMalformed: (_err, raw) => malformed.push(raw),
    });
    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "codex_start", arguments: { pad: "x".repeat(8_000) } },
    };
    const line = JSON.stringify(payload) + "\n";
    const mid = Math.floor(line.length / 2);
    reader.push(line.slice(0, mid));
    expect(messages).toHaveLength(0);
    expect(malformed).toHaveLength(0);
    reader.push(line.slice(mid));
    expect(malformed).toHaveLength(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ method: "tools/call", id: 1 });
  });

  it("does not dispatch a trailing partial without a newline", () => {
    const messages: unknown[] = [];
    const reader = new JsonLineReader({
      onMessage: (msg) => messages.push(msg),
    });
    reader.push('{"ok":true}');
    expect(messages).toHaveLength(0);
    reader.end();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ ok: true });
  });

  it("pushLine dispatches a complete line immediately", () => {
    const messages: unknown[] = [];
    const reader = new JsonLineReader({
      onMessage: (msg) => messages.push(msg),
    });
    reader.pushLine('{"from":"splitter"}');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ from: "splitter" });
  });

  it("applies the size cap to a retained partial line", () => {
    const oversized: string[] = [];
    const messages: unknown[] = [];
    const reader = new JsonLineReader({
      maxMessageBytes: 32,
      onMessage: (msg) => messages.push(msg),
      onOversized: (raw) => oversized.push(raw),
    });
    reader.push("n".repeat(40));
    expect(messages).toHaveLength(0);
    expect(oversized).toHaveLength(1);
    expect(oversized[0]?.length).toBe(40);
  });
});
