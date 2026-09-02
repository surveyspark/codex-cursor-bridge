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

/**
 * Keys a cloned repository must not be allowed to set. These flow into
 * execFile / sandbox / network policy; only user config, CLI flags, and
 * environment variables may supply them.
 */
export const PROJECT_RESTRICTED_KEYS = new Set([
  "codexBinaryPath",
  "cursorBinaryPath",
  "allowNonInteractiveCliFallback",
  "networkPolicy",
  "defaultPermissionProfile",
  "defaultImplementProfile",
]);

const PERMISSION_PROFILES = new Set([
  "read-only",
  "isolated-workspace-write",
  "current-workspace-write",
]);
const IMPLEMENT_PROFILES = new Set([
  "isolated-workspace-write",
  "current-workspace-write",
]);
const CURSOR_ADAPTERS = new Set(["auto", "sdk", "acp", "cli-fallback"]);
const NETWORK_POLICIES = new Set(["denied", "allowed"]);
const REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

function mergeLayer(
  base: BridgeConfig,
  layer: Record<string, unknown>,
  source: string,
  opts?: { denyKeys?: Set<string>; warnings?: string[] },
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
    if (opts?.denyKeys?.has(k)) {
      opts.warnings?.push(
        `ignoring untrusted project config key "${k}" from ${source}`,
      );
      continue;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (out as any)[k] = v;
  }
  return out;
}

function assertInteger(
  name: string,
  value: unknown,
  min: number,
  max: number,
): void {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new BridgeError(
      "BRIDGE_CONFIG_INVALID",
      `${name} must be an integer in [${min}, ${max}]`,
    );
  }
}

function assertBoolean(name: string, value: unknown): void {
  if (typeof value !== "boolean") {
    throw new BridgeError("BRIDGE_CONFIG_INVALID", `${name} must be a boolean`);
  }
}

function assertStringMax(name: string, value: unknown, max: number): void {
  if (typeof value !== "string" || value.length > max) {
    throw new BridgeError(
      "BRIDGE_CONFIG_INVALID",
      `${name} must be a string of at most ${max} characters`,
    );
  }
}

function assertEnum(name: string, value: unknown, allowed: Set<string>): void {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new BridgeError(
      "BRIDGE_CONFIG_INVALID",
      `${name} must be one of ${[...allowed].join(", ")}`,
    );
  }
}

/** Fail-closed value validation matching schemas/config.schema.json. */
export function validateBridgeConfig(config: BridgeConfig): void {
  if (config.schemaVersion !== "1.0") {
    throw new BridgeError(
      "BRIDGE_CONFIG_INVALID",
      'schemaVersion must be "1.0"',
    );
  }
  assertEnum(
    "preferredCursorAdapter",
    config.preferredCursorAdapter,
    CURSOR_ADAPTERS,
  );
  if (config.codexBinaryPath !== undefined) {
    assertStringMax("codexBinaryPath", config.codexBinaryPath, 4096);
  }
  if (config.cursorBinaryPath !== undefined) {
    assertStringMax("cursorBinaryPath", config.cursorBinaryPath, 4096);
  }
  assertInteger(
    "defaultTimeoutMs",
    config.defaultTimeoutMs,
    30_000,
    86_400_000,
  );
  assertInteger("maxConcurrency", config.maxConcurrency, 1, 16);
  assertInteger("jobRetentionDays", config.jobRetentionDays, 1, 365);
  assertInteger(
    "completedRetentionDays",
    config.completedRetentionDays,
    1,
    365,
  );
  if (config.worktreeRoot !== undefined) {
    assertStringMax("worktreeRoot", config.worktreeRoot, 4096);
  }
  assertEnum(
    "defaultPermissionProfile",
    config.defaultPermissionProfile,
    PERMISSION_PROFILES,
  );
  assertEnum(
    "defaultImplementProfile",
    config.defaultImplementProfile,
    IMPLEMENT_PROFILES,
  );
  if (config.defaultModel !== undefined && config.defaultModel !== null) {
    assertStringMax("defaultModel", config.defaultModel, 200);
  }
  if (
    config.defaultReasoningEffort !== undefined &&
    config.defaultReasoningEffort !== null
  ) {
    assertEnum(
      "defaultReasoningEffort",
      config.defaultReasoningEffort,
      REASONING_EFFORTS,
    );
  }
  assertEnum("networkPolicy", config.networkPolicy, NETWORK_POLICIES);
  assertBoolean("debugLogging", config.debugLogging);
  assertInteger("maxOutputBytes", config.maxOutputBytes, 10_000, 100_000_000);
  assertBoolean("autoReviewAfterExecution", config.autoReviewAfterExecution);
  assertBoolean("autoCorrectionPass", config.autoCorrectionPass);
  assertBoolean(
    "allowNonInteractiveCliFallback",
    config.allowNonInteractiveCliFallback,
  );
  assertInteger("maxHandoffDepth", config.maxHandoffDepth, 0, 2);
  assertInteger(
    "approvalTimeoutMs",
    config.approvalTimeoutMs,
    5_000,
    3_600_000,
  );
}

export interface LoadedConfig {
  config: BridgeConfig;
  sources: { user: string | null; project: string | null };
  warnings: string[];
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
  const warnings: string[] = [];

  const userFile = userConfigPath();
  const userLayer = readJsonFile(userFile);
  if (userLayer) config = mergeLayer(config, userLayer, userFile);

  let projectFile: string | null = null;
  if (repoRoot) {
    projectFile = projectConfigPath(repoRoot);
    const projectLayer = readJsonFile(projectFile);
    if (projectLayer) {
      config = mergeLayer(config, projectLayer, projectFile, {
        denyKeys: PROJECT_RESTRICTED_KEYS,
        warnings,
      });
    }
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

  validateBridgeConfig(config);

  return {
    config,
    sources: { user: userLayer ? userFile : null, project: projectFile },
    warnings,
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
