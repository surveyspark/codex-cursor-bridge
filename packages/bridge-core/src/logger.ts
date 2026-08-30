/**
 * Structured logging with redaction and size limits.
 */

import fs from "node:fs";
import path from "node:path";
import { redactString } from "./redact.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  /** File sink for this logger, when one is attached. */
  readonly filePath: string | null;
}

export interface CreateLoggerOptions {
  level?: LogLevel;
  filePath?: string | null;
  /** Max bytes for the log file; older content is rotated to .1 (one generation). */
  maxFileBytes?: number;
  /** Also mirror to stderr (used by CLI; MCP servers must keep stdout clean). */
  mirrorStderr?: boolean;
}

export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const level = opts.level ?? "info";
  const maxBytes = opts.maxFileBytes ?? 5_000_000;
  let filePath = opts.filePath ?? null;
  let wrote = 0;

  const ensureDir = (): void => {
    if (!filePath) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  };

  const rotateIfNeeded = (): void => {
    if (!filePath) return;
    try {
      const st = fs.statSync(filePath);
      wrote = st.size;
      if (st.size >= maxBytes) {
        fs.renameSync(filePath, `${filePath}.1`);
        wrote = 0;
      }
    } catch {
      wrote = 0;
    }
  };

  const write = (lvl: LogLevel, msg: string, data?: unknown): void => {
    if (LEVEL_ORDER[lvl] < LEVEL_ORDER[level]) return;
    const ts = new Date().toISOString();
    const redactedData =
      data === undefined
        ? ""
        : " " + redactString(
            typeof data === "string" ? data : JSON.stringify(redactValue(data)),
          );
    const line = `${ts} ${lvl.toUpperCase()} ${redactString(msg)}${redactedData}\n`;
    if (opts.mirrorStderr) {
      process.stderr.write(line);
    }
    if (!filePath) return;
    try {
      ensureDir();
      rotateIfNeeded();
      fs.appendFileSync(filePath, line);
      wrote += line.length;
    } catch {
      // Logging must never take the bridge down.
    }
  };

  return {
    debug: (m, d) => write("debug", m, d),
    info: (m, d) => write("info", m, d),
    warn: (m, d) => write("warn", m, d),
    error: (m, d) => write("error", m, d),
    get filePath(): string | null {
      return filePath;
    },
  };
}

/** Remove obviously sensitive keys and redact strings inside structured data. */
function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth-limit]";
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/^(authorization|cookie|password|secret|token|apiKey|api_key)$/i.test(k)) {
        out[k] = "***REDACTED***";
      } else {
        out[k] = redactValue(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  filePath: null,
};

export function getNullLogger(): Logger {
  return nullLogger;
}
