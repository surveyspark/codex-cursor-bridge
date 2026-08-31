/**
 * `doctor` — comprehensive, secret-free environment diagnostics.
 *
 * Every check yields: id, label, status (pass|warn|fail|info), detail, and
 * remediation text when failed. Exit code is 1 when any blocking check fails.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import {
  BRIDGE_VERSION,
  canonicalize,
  jobsDir,
  stateRoot,
  defaultWorktreeRoot,
  loadConfig,
  redactedConfig,
  resolveCursorCliName,
  type BridgeConfig,
} from "@codex-cursor-bridge/bridge-core";
import { JobStore } from "@codex-cursor-bridge/job-store";
import {
  CodexAppServerAdapter,
  CodexExecAdapter,
} from "@codex-cursor-bridge/codex-adapter";
import {
  CursorSdkAdapter,
  CursorAcpAdapter,
  CursorCliFallbackAdapter,
} from "@codex-cursor-bridge/cursor-adapter";
import { inspectGit } from "@codex-cursor-bridge/orchestrator";

const execFileAsync = promisify(execFile);

export type CheckStatus = "pass" | "warn" | "fail" | "info";

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  remediation?: string | undefined;
}

export interface DoctorResult {
  checks: Check[];
  text: string;
  exitCode: number;
  json: {
    bridgeVersion: string;
    platform: string;
    nodeVersion: string;
    checks: Check[];
    config: Record<string, unknown>;
    stateRoot: string;
  };
}

export async function runDoctor(opts: {
  repoRoot: string;
  json?: boolean;
}): Promise<DoctorResult> {
  const checks: Check[] = [];
  const add = (c: Check): void => {
    checks.push(c);
  };

  // Node version
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  add({
    id: "node.version",
    label: "Node.js version",
    status: nodeMajor >= 20 ? "pass" : "fail",
    detail: `${process.versions.node} (${process.platform} ${process.arch})`,
    remediation:
      nodeMajor >= 20
        ? undefined
        : "install Node.js >= 20.19 (https://nodejs.org)",
  });

  add({
    id: "bridge.version",
    label: "Bridge version",
    status: "info",
    detail: BRIDGE_VERSION,
  });

  // Git
  const gitInfo = await inspectGit(opts.repoRoot);
  add(
    gitInfo.version
      ? {
          id: "git.version",
          label: "Git",
          status: "pass",
          detail: gitInfo.version,
        }
      : {
          id: "git.version",
          label: "Git",
          status: "warn",
          detail: "git not found on PATH",
          remediation: "install git; worktree isolation requires it",
        },
  );
  if (gitInfo.isGit) {
    add({
      id: "git.repo",
      label: "Repository detection",
      status: "pass",
      detail: `root ${gitInfo.root}${gitInfo.hasCommits ? "" : " (no commits yet)"}${gitInfo.dirty ? ", working tree dirty" : ""}`,
    });
    if (!gitInfo.hasCommits) {
      add({
        id: "git.commits",
        label: "Initial commit",
        status: "warn",
        detail:
          "repository has no commits; worktree isolation unavailable until the first commit",
        remediation:
          "git commit your initial state, or use read-only delegation",
      });
    }
  } else {
    add({
      id: "git.repo",
      label: "Repository detection",
      status: "warn",
      detail: `${opts.repoRoot} is not inside a git repository`,
      remediation:
        "run the bridge from inside a repository for worktree isolation and diff summaries",
    });
  }

  // Codex
  const appServer = new CodexAppServerAdapter();
  const codexStatus = await appServer.isAvailable();
  add({
    id: "codex.cli",
    label: "Codex CLI",
    status: codexStatus.available ? "pass" : "warn",
    detail: codexStatus.available
      ? `codex ${codexStatus.version}`
      : (codexStatus.reason ?? "not found"),
    remediation: codexStatus.available
      ? undefined
      : "install: npm i -g @openai/codex",
  });
  if (codexStatus.available) {
    const probe = await appServer.probe();
    add({
      id: "codex.app-server",
      label: "Codex app-server",
      status: probe.ok ? "pass" : "warn",
      detail: probe.ok
        ? `initialize ok (${probe.userAgent ?? "app-server"})`
        : probe.detail,
      remediation: probe.ok
        ? undefined
        : "verify `codex app-server` runs and `codex login status` is OK",
    });
    try {
      const { stdout } = await execFileAsync("codex", ["login", "status"], {
        timeout: 15_000,
      });
      const txt = stdout.toLowerCase();
      const ok = !(
        txt.includes("not logged in") ||
        txt.includes("logged out") ||
        txt.trim().length === 0
      );
      add({
        id: "codex.auth",
        label: "Codex authentication",
        status: ok ? "pass" : "warn",
        detail: ok
          ? "login status OK (value withheld)"
          : stdout.trim().slice(0, 120) || "no login detected",
        remediation: ok
          ? undefined
          : "run `codex login` (ChatGPT account) or `printenv OPENAI_API_KEY | codex login --with-api-key`",
      });
    } catch (err) {
      add({
        id: "codex.auth",
        label: "Codex authentication",
        status: "warn",
        detail: `could not determine: ${(err as Error).message.split("\n")[0]?.slice(0, 120)}`,
        remediation: "run `codex login status` manually",
      });
    }
  }
  const execAdapter = new CodexExecAdapter();
  const execStatus = await execAdapter.isAvailable();
  add({
    id: "codex.exec-fallback",
    label: "Codex exec fallback",
    status: execStatus.available ? "pass" : "warn",
    detail: execStatus.available
      ? "available (one-shot; no live thread continuation)"
      : "codex CLI missing",
  });

  // Cursor
  const sdk = new CursorSdkAdapter();
  const sdkStatus = await sdk.isAvailable();
  add({
    id: "cursor.sdk",
    label: "Cursor SDK (@cursor/sdk)",
    status: sdkStatus.available ? "pass" : "info",
    detail: sdkStatus.available
      ? "available"
      : (sdkStatus.reason ?? "unavailable"),
    remediation: sdkStatus.available
      ? undefined
      : "optional: npm i -g @cursor/sdk and set CURSOR_API_KEY for server-side agents",
  });
  add({
    id: "cursor.api-key",
    label: "CURSOR_API_KEY",
    status: process.env.CURSOR_API_KEY ? "pass" : "info",
    detail: process.env.CURSOR_API_KEY ? "set (value withheld)" : "not set",
    remediation: process.env.CURSOR_API_KEY
      ? undefined
      : "required only for the SDK adapter; ACP uses your existing Cursor login",
  });

  const acp = new CursorAcpAdapter();
  const acpStatus = await acp.isAvailable();
  add({
    id: "cursor.cli",
    label: "Cursor CLI (agent)",
    status: acpStatus.available ? "pass" : "info",
    detail: acpStatus.available
      ? `agent (Cursor CLI) ${acpStatus.version}`
      : (acpStatus.reason ?? "not found"),
    remediation: acpStatus.available
      ? undefined
      : "optional: install the official CLI (curl https://cursor.com/install -fsS | bash), then `agent login`",
  });
  if (acpStatus.available) {
    const probe = await probeAcp();
    add({
      id: "cursor.acp",
      label: "Cursor ACP",
      status: probe.ok ? "pass" : "warn",
      detail: probe.detail,
      remediation: probe.ok
        ? undefined
        : "run `agent acp` manually; check `agent login`",
    });
  }
  const cliFallback = new CursorCliFallbackAdapter({
    allowNonInteractive: true,
  });
  const cliStatus = await cliFallback.isAvailable();
  add({
    id: "cursor.cli-fallback",
    label: "Cursor non-interactive CLI",
    status: cliStatus.available ? "warn" : "info",
    detail: cliStatus.available
      ? "present but gated: requires --allow-noninteractive-cli. Official docs: non-interactive mode has FULL WRITE ACCESS."
      : (cliStatus.reason ?? "unavailable"),
  });

  // Effective adapter selection
  let loadedConfig: BridgeConfig;
  try {
    const loaded = loadConfig(opts.repoRoot, undefined);
    loadedConfig = loaded.config;
    const selection = await selectAdapterQuietly(loadedConfig);
    add({
      id: "cursor.adapter-selection",
      label: "Cursor adapter selection",
      status: selection ? "info" : "warn",
      detail:
        selection ??
        "no adapter currently selectable (sdk/acp/cli all unavailable)",
    });
  } catch {
    loadedConfig = loadConfig(opts.repoRoot, undefined).config;
    add({
      id: "cursor.adapter-selection",
      label: "Cursor adapter selection",
      status: "warn",
      detail: "evaluation failed",
    });
  }

  // State directories
  try {
    fs.mkdirSync(jobsDir(), { recursive: true, mode: 0o700 });
    fs.accessSync(jobsDir(), fs.constants.W_OK);
    add({
      id: "state.jobs-dir",
      label: "Job state directory",
      status: "pass",
      detail: `${jobsDir()} (writable)`,
    });
  } catch (err) {
    add({
      id: "state.jobs-dir",
      label: "Job state directory",
      status: "fail",
      detail: `${jobsDir()} is not writable: ${(err as Error).message}`,
      remediation:
        "fix permissions or set CCB_STATE_DIR to a writable directory",
    });
  }
  add({
    id: "state.root",
    label: "State root",
    status: "info",
    detail: stateRoot(),
  });
  add({
    id: "state.worktrees",
    label: "Worktree root",
    status: "info",
    detail: defaultWorktreeRoot(),
  });

  // Stale/conflicting jobs
  try {
    const store = new JobStore({ jobsDir: jobsDir() });
    const jobs = store.list();
    const nonTerminal = jobs.filter(
      (j) =>
        !["completed", "failed", "cancelled", "timed-out"].includes(j.status),
    );
    add({
      id: "state.jobs",
      label: "Existing jobs",
      status: nonTerminal.length > 0 ? "warn" : "info",
      detail:
        jobs.length === 0
          ? "none"
          : `${jobs.length} job(s), ${nonTerminal.length} non-terminal${nonTerminal.length > 0 ? " (run `jobs recover` after a crash)" : ""}`,
    });
  } catch {
    add({
      id: "state.jobs",
      label: "Existing jobs",
      status: "info",
      detail: "no jobs yet",
    });
  }

  // Config summary
  add({
    id: "config.effective",
    label: "Effective configuration",
    status: "info",
    detail: JSON.stringify(redactedConfig(loadedConfig)),
  });

  const blocking = checks.filter((c) => c.status === "fail");
  const exitCode = blocking.length > 0 ? 1 : 0;

  const text = [
    "codex-cursor-bridge doctor",
    "",
    ...checks.map((c) => {
      const icon =
        c.status === "pass"
          ? "✓"
          : c.status === "fail"
            ? "✗"
            : c.status === "warn"
              ? "!"
              : "·";
      let line = `${icon} ${c.label}: ${c.detail}`;
      if (c.remediation) line += `\n    → ${c.remediation}`;
      return line;
    }),
    "",
    blocking.length > 0
      ? `${blocking.length} blocking issue(s); see remediations above.`
      : "No blocking issues.",
  ].join("\n");

  return {
    checks,
    text,
    exitCode,
    json: {
      bridgeVersion: BRIDGE_VERSION,
      platform: `${process.platform}-${process.arch}`,
      nodeVersion: process.versions.node,
      checks,
      config: redactedConfig(loadedConfig) as Record<string, unknown>,
      stateRoot: stateRoot(),
    },
  };
}

async function probeAcp(): Promise<{ ok: boolean; detail: string }> {
  const bin = process.env.CCB_CURSOR_BINARY ?? (await resolveCursorCliName());
  return new Promise((resolve) => {
    let child: ReturnType<typeof execFile>;
    try {
      child = execFile(bin, ["acp"], { timeout: 15_000 }, () => {});
    } catch (err) {
      resolve({ ok: false, detail: `spawn failed: ${(err as Error).message}` });
      return;
    }
    let settled = false;
    const done = (ok: boolean, detail: string): void => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve({ ok, detail });
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (text.includes('"jsonrpc"')) {
        done(true, "ACP responds to stdio (JSON-RPC detected)");
      }
    });
    child.stderr?.on("data", () => {});
    child.on("error", (err) => done(false, `ACP spawn error: ${err.message}`));
    child.on("exit", () =>
      done(false, "ACP exited without responding to initialize"),
    );
    child.stdin?.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {} },
      }) + "\n",
    );
    setTimeout(() => done(false, "no ACP response within timeout"), 12_000);
  });
}

async function selectAdapterQuietly(
  config: BridgeConfig,
): Promise<string | null> {
  try {
    const { selectCursorAdapter } =
      await import("@codex-cursor-bridge/cursor-adapter");
    const sel = await selectCursorAdapter({
      config,
      ...(config.cursorBinaryPath
        ? { cursorBinaryPath: config.cursorBinaryPath }
        : {}),
    });
    return `${sel.adapter.name} (${sel.selectionReason})`;
  } catch {
    return null;
  }
}

export function repoRootFrom(cwd: string): string {
  return canonicalize(cwd);
}
