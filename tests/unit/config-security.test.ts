import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BridgeError, loadConfig, makeTempRepo } from "../helpers.js";

const originalXdg = process.env.XDG_CONFIG_HOME;
const originalHome = process.env.HOME;

afterEach(() => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

function isolatedUserConfig(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-xdg-"));
  process.env.XDG_CONFIG_HOME = dir;
  fs.mkdirSync(path.join(dir, "codex-cursor-bridge"), {
    recursive: true,
    mode: 0o700,
  });
  return dir;
}

describe("untrusted project config", () => {
  it("ignores project cursorBinaryPath and warns", async () => {
    isolatedUserConfig();
    const { repo, cleanup } = await makeTempRepo({});
    try {
      fs.mkdirSync(path.join(repo, ".handoff"), { recursive: true });
      fs.writeFileSync(
        path.join(repo, ".handoff", "config.json"),
        JSON.stringify({
          cursorBinaryPath: "/tmp/evil-cursor",
          maxConcurrency: 2,
        }),
      );
      const loaded = loadConfig(repo);
      expect(loaded.config.cursorBinaryPath).toBeUndefined();
      expect(loaded.warnings.some((w) => w.includes("cursorBinaryPath"))).toBe(
        true,
      );
      expect(loaded.config.maxConcurrency).toBe(2);
    } finally {
      cleanup();
    }
  });

  it("rejects project maxConcurrency: 0 with BRIDGE_CONFIG_INVALID", async () => {
    isolatedUserConfig();
    const { repo, cleanup } = await makeTempRepo({});
    try {
      fs.mkdirSync(path.join(repo, ".handoff"), { recursive: true });
      fs.writeFileSync(
        path.join(repo, ".handoff", "config.json"),
        JSON.stringify({ maxConcurrency: 0 }),
      );
      expect(() => loadConfig(repo)).toThrow(BridgeError);
      try {
        loadConfig(repo);
      } catch (err) {
        expect(err).toBeInstanceOf(BridgeError);
        expect((err as BridgeError).code).toBe("BRIDGE_CONFIG_INVALID");
      }
    } finally {
      cleanup();
    }
  });

  it("rejects a bad permission profile enum and too-small timeout", async () => {
    isolatedUserConfig();
    const { repo, cleanup } = await makeTempRepo({});
    try {
      fs.mkdirSync(path.join(repo, ".handoff"), { recursive: true });
      fs.writeFileSync(
        path.join(repo, ".handoff", "config.json"),
        JSON.stringify({ defaultTimeoutMs: 10 }),
      );
      try {
        loadConfig(repo);
        expect.fail("expected BRIDGE_CONFIG_INVALID");
      } catch (err) {
        expect((err as BridgeError).code).toBe("BRIDGE_CONFIG_INVALID");
      }
      fs.writeFileSync(
        path.join(repo, ".handoff", "config.json"),
        JSON.stringify({ maxConcurrency: 1 }),
      );
      // defaultPermissionProfile is restricted in project config, so a typo
      // there is ignored rather than applied; user config still validates.
      const userDir = process.env.XDG_CONFIG_HOME!;
      fs.writeFileSync(
        path.join(userDir, "codex-cursor-bridge", "config.json"),
        JSON.stringify({ defaultPermissionProfile: "readonly" }),
      );
      try {
        loadConfig(null);
        expect.fail("expected BRIDGE_CONFIG_INVALID");
      } catch (err) {
        expect((err as BridgeError).code).toBe("BRIDGE_CONFIG_INVALID");
      }
    } finally {
      cleanup();
    }
  });

  it("accepts cursorBinaryPath from user config", () => {
    const dir = isolatedUserConfig();
    fs.writeFileSync(
      path.join(dir, "codex-cursor-bridge", "config.json"),
      JSON.stringify({ cursorBinaryPath: "/usr/bin/cursor" }),
    );
    const loaded = loadConfig(null);
    expect(loaded.config.cursorBinaryPath).toBe("/usr/bin/cursor");
    expect(loaded.warnings).toEqual([]);
  });
});
