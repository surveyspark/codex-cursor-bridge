import { afterAll, describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { getNullLogger, makeTempRepo, serveMcp, waitFor } from "../helpers.js";

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const c of cleanups) c();
});

describe("MCP stdio JSON-RPC framing", () => {
  it("parses a >64 KiB initialize split across two stdin writes", async () => {
    const { repo, cleanup } = await makeTempRepo({});
    cleanups.push(cleanup);
    process.env.CCB_STATE_DIR = path.join(repo, ".state");
    fs.mkdirSync(path.join(repo, ".state"), { recursive: true, mode: 0o700 });

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let out = "";
    stdout.on("data", (chunk: Buffer | string) => {
      out += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });

    await serveMcp({
      host: "cursor",
      repoRoot: repo,
      stdin,
      stdout,
      logger: getNullLogger(),
    });

    const payload =
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          clientInfo: {
            name: "n".repeat(70_000),
            version: "0.0.0",
          },
        },
      }) + "\n";
    expect(payload.length).toBeGreaterThan(64 * 1024);
    const mid = Math.floor(payload.length / 2);
    stdin.write(payload.slice(0, mid));
    stdin.write(payload.slice(mid));

    await waitFor(
      () => out.includes('"id":1') && out.includes("serverInfo"),
      8_000,
    );
    const line = out.split("\n").find((l) => l.includes('"id":1'));
    expect(line).toBeTruthy();
    const msg = JSON.parse(line!) as {
      jsonrpc: string;
      id: number;
      result?: { serverInfo?: { name?: string } };
      error?: unknown;
    };
    expect(msg.jsonrpc).toBe("2.0");
    expect(msg.id).toBe(1);
    expect(msg.error).toBeUndefined();
    expect(msg.result?.serverInfo?.name).toMatch(/Codex tools/);
    stdin.end();
  }, 20_000);
});
