/**
 * Safe child-process helpers.
 *
 * Security invariants:
 * - Spawn with argument arrays only; never `shell: true`.
 * - Secrets are passed via env var *names* configured by the caller; the
 *   bridge never places prompts in command-line arguments (stdin instead).
 * - Cancellation terminates the whole process group (POSIX) or process tree
 *   (Windows) after a graceful grace period.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { StringDecoder } from "node:string_decoder";
import { BridgeError } from "./errors.js";

export interface SpawnOptions {
  cwd: string;
  argv: string[];
  env?: Record<string, string>;
  /** Environment variable names to forward from this process if present. */
  forwardEnv?: string[];
  stdinData?: string;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** Called when a logical line exceeds the splitter cap (the line is dropped). */
  onOversizedLine?: (stream: "stdout" | "stderr") => void;
  abortSignal?: AbortSignal;
  /** Kill grace period before SIGKILL / taskkill /F. Default 3000ms. */
  killGraceMs?: number;
  /** Hard cap for stdout+stderr capture to avoid unbounded memory. */
  maxBufferBytes?: number;
}

export interface SpawnOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

export interface SpawnHandle {
  child: ChildProcess;
  done: Promise<SpawnOutcome>;
  killTree: () => Promise<void>;
}

const isWindows = process.platform === "win32";

/** Build a conservative environment for child processes. */
export function buildChildEnv(
  forward: string[] = [],
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  // Minimal stable defaults every CLI needs.
  const defaults = [
    "PATH",
    "PATHEXT",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "TMP",
    "TEMP",
    "SYSTEMROOT",
    "COMSPEC",
    "LANG",
    "TZ",
  ];
  for (const name of defaults) {
    const v = process.env[name];
    if (v !== undefined) env[name] = v;
  }
  for (const name of forward) {
    const v = process.env[name];
    if (v !== undefined) env[name] = v;
  }
  Object.assign(env, extra);
  return env;
}

/** Spawn a process detached in its own process group (POSIX) for clean tree kills. */
export function spawnProcess(opts: SpawnOptions): SpawnHandle {
  if (opts.argv.length === 0 || typeof opts.argv[0] !== "string") {
    throw new BridgeError("BRIDGE_USAGE", "argv[0] must be a program path");
  }
  const child = spawn(opts.argv[0]!, opts.argv.slice(1), {
    cwd: opts.cwd,
    env: opts.env ?? buildChildEnv(opts.forwardEnv ?? []),
    stdio: ["pipe", "pipe", "pipe"],
    // Detached + group leader on POSIX lets us kill the entire tree.
    detached: !isWindows,
    windowsHide: true,
    shell: false,
  });

  let killed = false;
  let timedOut = false;

  const killTree = async (): Promise<void> => {
    if (killed || child.pid === undefined) return;
    killed = true;
    if (isWindows) {
      // taskkill /T kills the full tree; /F forces.
      const tk = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
      });
      await new Promise<void>((resolve) => tk.once("close", () => resolve()));
    } else {
      try {
        // Negative pid targets the whole process group.
        process.kill(-child.pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      }
      const grace = opts.killGraceMs ?? 3000;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, grace);
        child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
      try {
        if (child.pid !== undefined && child.exitCode === null) {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  };

  const wireLineSplitter = (
    stream: NodeJS.ReadableStream | null,
    isErr: boolean,
  ): void => {
    if (!stream) return;
    const decoder = new StringDecoder("utf8");
    let pending = "";
    // Must exceed JsonLineReader's default 16 MiB cap so the reader, not the
    // splitter, owns oversized-message handling.
    const maxLine = 17 * 1024 * 1024;
    const emit = (line: string): void => {
      if (isErr) opts.onStderrLine?.(line);
      else opts.onStdoutLine?.(line);
    };
    stream.on("data", (chunk: Buffer) => {
      pending += decoder.write(chunk);
      let idx: number;
      while ((idx = pending.indexOf("\n")) >= 0) {
        let line = pending.slice(0, idx);
        pending = pending.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.length > maxLine) {
          opts.onOversizedLine?.(isErr ? "stderr" : "stdout");
          continue;
        }
        emit(line);
      }
      if (pending.length > maxLine) {
        pending = "";
        opts.onOversizedLine?.(isErr ? "stderr" : "stdout");
      }
    });
    stream.on("end", () => {
      pending += decoder.end();
      if (pending.length > 0 && pending.length <= maxLine) emit(pending);
      pending = "";
    });
  };

  wireLineSplitter(child.stdout, false);
  wireLineSplitter(child.stderr, true);

  child.stdin?.on("error", () => {
    // EPIPE when the child exits early; stdout/stderr handling reports it.
  });
  // Keep stdin open until the caller ends it explicitly; ending immediately
  // breaks long-lived protocol children that read stdin lazily.
  if (opts.stdinData !== undefined) {
    child.stdin?.write(opts.stdinData);
    child.stdin?.end();
  }

  const abort = (): void => {
    timedOut = true;
    void killTree();
  };
  if (opts.abortSignal) {
    if (opts.abortSignal.aborted) abort();
    else opts.abortSignal.addEventListener("abort", abort, { once: true });
  }

  const done = new Promise<SpawnOutcome>((resolve, reject) => {
    child.once("error", (err) => {
      reject(
        new BridgeError(
          "ADAPTER_SPAWN_FAILED",
          `failed to spawn ${opts.argv[0]}: ${err.message}`,
          { cause: err },
        ),
      );
    });
    child.once("exit", (code, signal) => {
      resolve({ code, signal, timedOut });
    });
  });

  return { child, done, killTree };
}

/**
 * Simple process liveness check with stale-detection support.
 * Returns true when a process with this pid exists. Note: on its own this
 * cannot distinguish recycled pids; callers must combine with job metadata.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EPERM") return true; // exists but not ours
    return false;
  }
}

/**
 * Identifier for the current OS boot. Combined with a recorded pid so
 * crash recovery can tell a live process from a recycled pid after reboot.
 * Override with CCB_BOOT_ID in tests.
 */
/** Terminate an arbitrary pid's process tree (cross-process cancel). */
export async function killPidTree(pid: number, graceMs = 3000): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (isWindows) {
    const tk = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      shell: false,
      windowsHide: true,
    });
    await new Promise<void>((resolve) => tk.once("close", () => resolve()));
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
}

export function currentBootId(): string {
  const override = process.env.CCB_BOOT_ID;
  if (override && override.length > 0) return override;
  try {
    const linuxId = fs
      .readFileSync("/proc/sys/kernel/random/boot_id", "utf8")
      .trim();
    if (linuxId.length > 0) return linuxId;
  } catch {
    // Not Linux, or unreadable.
  }
  // Date.now()/uptime can jitter by a few milliseconds across processes;
  // a 10s bucket keeps sibling MCP servers on the same boot aligned.
  const bootEpochMs = Date.now() - os.uptime() * 1000;
  return `${process.platform}-${Math.round(bootEpochMs / 10_000)}`;
}
