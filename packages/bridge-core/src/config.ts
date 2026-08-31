/**
 * Configuration loading with documented precedence:
 *   1. Explicit invocation options (handled by callers)
 *   2. Project configuration (.handoff/config.json)
 *   3. User configuration ($XDG_CONFIG_HOME/codex-cursor-bridge/config.json
 *      or ~/.config/codex-cursor-bridge/config.json)
 *   4. Environment variables (secrets/deployment only; never persisted)
 *   5. Safe defaults
 *
 * Secrets are never read from config files. CURSOR_API_KEY and OPENAI_API_KEY
 * are consumed by the underlying CLIs/SDKs directly from the environment.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, type BridgeConfig } from "./types.js";
import { BridgeError } from "./errors.js";

export function userConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base =
    xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "codex-cursor-bridge", "config.json");
}

export function projectConfigPath(repoRoot: string): string {
  return path.join(repoRoot, ".handoff", "config.json");
}

function readJsonFile(file: string): Record<string, unknown> | null {
  try {
    const text = fs.readFileSync(file, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new BridgeError(
        "BRIDGE_CONFIG_INVALID",
        `${file} must contain a JSON object`,
      );
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    if (err instanceof BridgeError) throw err;
    throw new BridgeError(
      "BRIDGE_CONFIG_INVALID",
      `failed to read ${file}: ${e.message}`,
      { cause: err },
    );
  }
}

const KNOWN_KEYS = new Set([
  "schemaVersion",
  "preferredCursorAdapter",
  "codexBinaryPath",
  "cursorBinaryPath",
  "defaultTimeoutMs",
  "maxConcurrency",
  "jobRetentionDays",
  "completedRetentionDays",
  "worktreeRoot",
  "defaultPermissionProfile",
  "defaultImplementProfile",
  "defaultModel",
  "defaultReasoningEffort",
  "networkPolicy",
  "debugLogging",
  "maxOutputBytes",
  "autoReviewAfterExecution",
  "autoCorrectionPass",
  "allowNonInteractiveCliFallback",
  "maxHandoffDepth",
  "approvalTimeoutMs",
]);

function mergeLayer(
  base: BridgeConfig,
  layer: Record<string, unknown>,
  source: string,
): BridgeConfig {
  const out: BridgeConfig = { ...base };
  for (const [k, v] of Object.entries(layer)) {
    if (!KNOWN_KEYS.has(k)) {
      throw new BridgeError(
        "BRIDGE_CONFIG_INVALID",
        `unknown config key "${k}" in ${source}`,
      );
    }
    if (k === "schemaVersion") continue;
    if (v === undefined) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (out as any)[k] = v;
  }
  return out;
}

export interface LoadedConfig {
  config: BridgeConfig;
  sources: { user: string | null; project: string | null };
}

/**
 * Load effective configuration. `repoRoot` may be null when running outside
 * a repository (doctor, config commands).
 */
export function loadConfig(
  repoRoot: string | null,
  overrides?: Partial<BridgeConfig>,
): LoadedConfig {
  let config: BridgeConfig = { ...DEFAULT_CONFIG };

  const userFile = userConfigPath();
  const userLayer = readJsonFile(userFile);
  if (userLayer) config = mergeLayer(config, userLayer, userFile);

  let projectFile: string | null = null;
  if (repoRoot) {
    projectFile = projectConfigPath(repoRoot);
    const projectLayer = readJsonFile(projectFile);
    if (projectLayer) config = mergeLayer(config, projectLayer, projectFile);
  }

  if (overrides) {
    config = mergeLayer(
      config,
      Object.fromEntries(
        Object.entries(overrides).filter(([, v]) => v !== undefined),
      ) as Record<string, unknown>,
      "invocation-overrides",
    );
  }

  // Environment deployment knobs (documented; secrets stay with the CLIs).
  if (process.env.CCB_CODEX_BINARY)
    config.codexBinaryPath = process.env.CCB_CODEX_BINARY;
  if (process.env.CCB_CURSOR_BINARY)
    config.cursorBinaryPath = process.env.CCB_CURSOR_BINARY;

  return {
    config,
    sources: { user: userLayer ? userFile : null, project: projectFile },
  };
}

/** Effective configuration with secret-bearing entries removed (there are none by design). */
export function redactedConfig(config: BridgeConfig): Record<string, unknown> {
  return {
    ...config,
    _secrets:
      "none stored; CURSOR_API_KEY/OPENAI_API_KEY stay in the environment",
  };
}

/** Job state root directory (OS-appropriate). */
export function stateRoot(): string {
  const override = process.env.CCB_STATE_DIR;
  if (override && path.isAbsolute(override)) return override;
  if (process.platform === "win32") {
    const base =
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "codex-cursor-bridge");
  }
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "codex-cursor-bridge",
    );
  }
  const xdg = process.env.XDG_STATE_HOME;
  const base =
    xdg && path.isAbsolute(xdg)
      ? xdg
      : path.join(os.homedir(), ".local", "state");
  return path.join(base, "codex-cursor-bridge");
}

export function jobsDir(): string {
  return path.join(stateRoot(), "jobs");
}

export function logsDir(): string {
  return path.join(stateRoot(), "logs");
}

export function defaultWorktreeRoot(): string {
  return path.join(stateRoot(), "worktrees");
}
