#!/usr/bin/env node
/**
 * codex-cursor-bridge CLI.
 *
 * Commands:
 *   doctor                          Diagnose environment, adapters, auth (redacted)
 *   mcp --host cursor|codex         Run the host-scoped MCP stdio server
 *   codex start|status|result|reply|cancel|list
 *   cursor start|status|result|reply|cancel|list
 *   jobs list|clean
 *   config show
 *   demos list|run <name>
 *
 * Output is stable, scriptable text plus --json variants where noted.
 */

import {
  BridgeError,
  asBridgeError,
  canonicalize,
  createLogger,
  getNullLogger,
  redactString,
  validateStartRequest,
  type StartRequest,
} from "@codex-cursor-bridge/bridge-core";
import { JobStore } from "@codex-cursor-bridge/job-store";
import {
  CodexAppServerAdapter,
  CodexExecAdapter,
} from "@codex-cursor-bridge/codex-adapter";
import { selectCursorAdapter } from "@codex-cursor-bridge/cursor-adapter";
import { JobManager } from "@codex-cursor-bridge/orchestrator";
import { serveMcp } from "@codex-cursor-bridge/mcp-server";
import { runDoctor } from "./doctor.js";
import {
  jobsDir,
  stateRoot,
  defaultWorktreeRoot,
  BRIDGE_VERSION,
  isCliEntrypoint,
} from "./shared.js";
import { runDemos } from "./demos.js";

interface ParsedArgs {
  flags: Map<string, string | boolean>;
  positionals: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags.set(a.slice(2, eq), a.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags.set(a.slice(2), next);
          i++;
        } else {
          flags.set(a.slice(2), true);
        }
      }
    } else if (a.startsWith("-") && a.length > 1) {
      flags.set(a.slice(1), true);
    } else {
      positionals.push(a);
    }
  }
  return { flags, positionals };
}

function usage(): string {
  return [
    `codex-cursor-bridge ${BRIDGE_VERSION} — two-way Codex ⇄ Cursor delegation`,
    "",
    "Usage:",
    "  codex-cursor-bridge doctor [--json] [--repo <path>]",
    "  codex-cursor-bridge mcp --host cursor|codex [--repo <path>]",
    "  codex-cursor-bridge codex  start|status <jobId>|result <jobId>|reply <jobId> <message>|cancel <jobId>|list",
    "  codex-cursor-bridge cursor start|status <jobId>|result <jobId>|reply <jobId> <message>|cancel <jobId>|list",
    "  codex-cursor-bridge jobs list|clean [--dry-run]",
    "  codex-cursor-bridge config show [--json]",
    "  codex-cursor-bridge demos list|run <name>",
    "",
    "Run 'codex-cursor-bridge <command> --help' for details.",
  ].join("\n");
}

function findRepoRoot(explicit?: string): string {
  return canonicalize(explicit ?? process.cwd());
}

function printJson(v: unknown): void {
  process.stdout.write(JSON.stringify(v, null, 2) + "\n");
}

function die(err: unknown): never {
  const be = asBridgeError(err);
  process.stderr.write(`error ${be.code}: ${redactString(be.message)}\n`);
  process.exit(1);
}

async function makeManager(
  repoRoot: string,
  overrides: Record<string, unknown>,
  quiet = false,
): Promise<JobManager> {
  const log = quiet
    ? getNullLogger()
    : createLogger({
        level: process.env.CCB_DEBUG ? "debug" : "info",
        filePath: `${stateRoot()}/logs/cli.log`,
      });
  return new JobManager({
    repoRoot,
    config: overrides as never,
    logger: log,
    selectAdapter: async (_request, record) => {
      if (record.targetHost === "codex") {
        const ob = (overrides as { codexBinaryPath?: string }).codexBinaryPath;
        const appServer = new CodexAppServerAdapter({
          ...(ob ? { codexBinaryPath: ob } : {}),
        });
        const st = await appServer.isAvailable();
        if (st.available) {
          const probe = await appServer.probe();
          if (probe.ok)
            return {
              adapter: appServer,
              reason: "codex app-server initialize succeeded",
            };
        }
        const fallback = new CodexExecAdapter({
          ...(ob ? { codexBinaryPath: ob } : {}),
        });
        if ((await fallback.isAvailable()).available) {
          return {
            adapter: fallback,
            reason: `codex exec fallback (app-server unavailable: ${st.reason ?? "probe failed"})`,
          };
        }
        throw new BridgeError(
          "ADAPTER_NOT_AVAILABLE",
          `no Codex adapter available (${st.reason ?? "probe failed"})`,
        );
      }
      const { config } = await import("@codex-cursor-bridge/bridge-core").then(
        (m) => m.loadConfig(repoRoot, overrides as never),
      );
      const selection = await selectCursorAdapter({
        config,
        ...(config.cursorBinaryPath
          ? { cursorBinaryPath: config.cursorBinaryPath }
          : {}),
      });
      return { adapter: selection.adapter, reason: selection.selectionReason };
    },
  });
}

async function main(argv: string[]): Promise<void> {
  const { flags, positionals } = parseArgs(argv);
  const command = positionals[0];

  if (flags.has("version")) {
    process.stdout.write(BRIDGE_VERSION + "\n");
    return;
  }
  if (!command || flags.has("help") || flags.has("h")) {
    process.stdout.write(usage() + "\n");
    if (!command) process.exitCode = positionals.length === 0 ? 1 : 0;
    return;
  }

  switch (command) {
    case "doctor": {
      const repoRoot = findRepoRoot(flags.get("repo") as string | undefined);
      const result = await runDoctor({ repoRoot, json: flags.has("json") });
      if (flags.has("json")) printJson(result.json);
      else process.stdout.write(result.text + "\n");
      process.exitCode = result.exitCode;
      return;
    }

    case "mcp": {
      const host = String(flags.get("host") ?? "");
      if (host !== "cursor" && host !== "codex") {
        throw new BridgeError(
          "BRIDGE_USAGE",
          "mcp requires --host cursor|codex",
        );
      }
      const repoRoot = findRepoRoot(flags.get("repo") as string | undefined);
      await serveMcp({ host, repoRoot });
      return;
    }

    case "codex":
    case "cursor": {
      const host = command as "codex" | "cursor";
      const sub = positionals[1];
      const repoRoot = findRepoRoot(flags.get("repo") as string | undefined);
      const overrides: Record<string, unknown> = {};
      if (flags.has("allow-noninteractive-cli"))
        overrides.allowNonInteractiveCliFallback = true;
      if (flags.has("model"))
        overrides.defaultModel = String(flags.get("model"));
      if (flags.has("debug")) overrides.debugLogging = true;

      if (!sub || sub === "list") {
        const manager = await makeManager(repoRoot, overrides);
        const jobs = manager
          .list()
          .filter((j) => j.targetHost === host)
          .slice(-20)
          .reverse();
        if (flags.has("json")) {
          printJson(
            jobs.map((j) => ({
              jobId: j.jobId,
              status: j.status,
              mode: j.mode,
              adapter: j.adapter,
              nativeId: j.nativeId,
              createdAt: j.createdAt,
            })),
          );
        } else if (jobs.length === 0) {
          process.stdout.write("no jobs\n");
        } else {
          for (const j of jobs) {
            process.stdout.write(
              `${j.jobId}  ${j.status.padEnd(10)} ${j.mode.padEnd(18)} ${j.adapter.padEnd(22)} ${j.nativeId ?? "-"}\n`,
            );
          }
        }
        return;
      }

      switch (sub) {
        case "start": {
          const task = flags.get("task");
          if (typeof task !== "string" || task.length === 0) {
            throw new BridgeError(
              "BRIDGE_USAGE",
              'start requires --task "<delegated task>"',
            );
          }
          const mode = String(flags.get("mode") ?? "investigate");
          const profileFlag = flags.get("profile");
          const request: StartRequest = {
            task,
            cwd: findRepoRoot(
              (flags.get("cwd") as string | undefined) ??
                (flags.get("repo") as string | undefined),
            ),
            mode: mode as StartRequest["mode"],
            permissionProfile: (typeof profileFlag === "string"
              ? profileFlag
              : undefined) as StartRequest["permissionProfile"],
            background: true,
            ...(typeof flags.get("model") === "string"
              ? { model: flags.get("model") as string }
              : {}),
            ...(typeof flags.get("effort") === "string"
              ? {
                  reasoningEffort: flags.get("effort") as
                    | "low"
                    | "medium"
                    | "high"
                    | "xhigh",
                }
              : {}),
            ...(typeof flags.get("base-ref") === "string"
              ? { baseRef: flags.get("base-ref") as string }
              : {}),
            ...(typeof flags.get("timeout") === "string"
              ? { timeoutMs: parseInt(flags.get("timeout") as string, 10) }
              : {}),
            ...(typeof flags.get("constraints") === "string"
              ? { constraints: [flags.get("constraints") as string] }
              : {}),
            ...(typeof flags.get("expected-output") === "string"
              ? { expectedOutput: flags.get("expected-output") as string }
              : {}),
            origin: { host: "cli", handoffDepth: 0, maxHandoffDepth: 1 },
          };
          const vr = validateStartRequest(request);
          if (!vr.ok) {
            throw new BridgeError(
              "BRIDGE_USAGE",
              `invalid start arguments: ${vr.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
            );
          }
          const manager = await makeManager(repoRoot, overrides);
          const enq = await manager.enqueue(vr.value as StartRequest, {
            host: "cli",
            tool: "cli",
            client: "terminal",
            targetHost: host,
          });
          process.stdout.write(`job ${enq.jobId} queued (${host})\n`);
          const result = await manager.run(enq.jobId);
          if (flags.has("json")) {
            printJson({
              jobId: result.jobId,
              nativeId: result.nativeId,
              status: result.status,
              result,
            });
          } else {
            process.stdout.write(`status: ${result.status}\n`);
            if (result.nativeId)
              process.stdout.write(`native id: ${result.nativeId}\n`);
            process.stdout.write(`\n${result.summary}\n`);
          }
          process.exitCode = result.status === "completed" ? 0 : 1;
          return;
        }
        case "status": {
          const jobId = positionals[2];
          if (!jobId)
            throw new BridgeError("BRIDGE_USAGE", "status requires <jobId>");
          const manager = await makeManager(repoRoot, overrides);
          const record = manager.get(jobId);
          if (flags.has("json")) {
            printJson({
              jobId: record.jobId,
              status: record.status,
              adapter: record.adapter,
              nativeId: record.nativeId,
              worktree: record.worktree ?? null,
              recentEvents: record.events.slice(-10),
            });
          } else {
            process.stdout.write(
              `job ${record.jobId}\nstatus: ${record.status}\nadapter: ${record.adapter}\nnative id: ${record.nativeId ?? "-"}\n`,
            );
            if (record.worktree)
              process.stdout.write(
                `worktree: ${record.worktree.path} (branch ${record.worktree.branch})\n`,
              );
            process.stdout.write(`events:\n`);
            for (const e of record.events.slice(-10))
              process.stdout.write(`  ${e.ts} ${e.type}\n`);
          }
          return;
        }
        case "result": {
          const jobId = positionals[2];
          if (!jobId)
            throw new BridgeError("BRIDGE_USAGE", "result requires <jobId>");
          const manager = await makeManager(repoRoot, overrides);
          const record = manager.get(jobId);
          if (flags.has("json")) {
            printJson({
              jobId: record.jobId,
              status: record.status,
              nativeId: record.nativeId,
              result: record.result,
            });
          } else if (record.result) {
            process.stdout.write(`${record.result.summary}\n`);
            if (record.result.changedFiles?.length) {
              process.stdout.write(`\nchanged files:\n`);
              for (const f of record.result.changedFiles)
                process.stdout.write(`  ${f.change.padEnd(8)} ${f.path}\n`);
            }
            if (record.result.diffStat) {
              process.stdout.write(
                `\ndiff: ${record.result.diffStat.filesChanged} file(s), +${record.result.diffStat.insertions} -${record.result.diffStat.deletions}\n`,
              );
            }
            if (record.result.diffPatchPath)
              process.stdout.write(`patch: ${record.result.diffPatchPath}\n`);
          } else {
            process.stdout.write(`no result yet (status ${record.status})\n`);
            process.exitCode = 2;
          }
          return;
        }
        case "reply": {
          const jobId = positionals[2];
          const message = positionals.slice(3).join(" ");
          if (!jobId || !message)
            throw new BridgeError(
              "BRIDGE_USAGE",
              "reply requires <jobId> <message>",
            );
          const manager = await makeManager(repoRoot, overrides);
          const record = manager.get(jobId);
          if (!record.nativeId)
            throw new BridgeError(
              "BRIDGE_NOT_SUPPORTED",
              `job ${jobId} has no native session id`,
            );
          process.stdout.write(
            `sending follow-up to native session ${record.nativeId}...\n`,
          );
          const result = await manager.reply(jobId, message);
          if (flags.has("json")) {
            printJson(result);
          } else if (result.accepted && result.result) {
            process.stdout.write(`${result.result.summary}\n`);
          } else {
            process.stdout.write(
              `follow-up not accepted: ${result.note ?? "unsupported"}\n`,
            );
            process.exitCode = 1;
          }
          return;
        }
        case "cancel": {
          const jobId = positionals[2];
          if (!jobId)
            throw new BridgeError("BRIDGE_USAGE", "cancel requires <jobId>");
          const manager = await makeManager(repoRoot, overrides, true);
          const result = await manager.cancel(jobId, "cancelled via CLI");
          process.stdout.write(`job ${result.jobId} cancelled\n`);
          return;
        }
        default:
          throw new BridgeError(
            "BRIDGE_USAGE",
            `unknown ${command} subcommand: ${sub}`,
          );
      }
    }

    case "jobs": {
      const sub = positionals[1] ?? "list";
      const store = new JobStore({ jobsDir: jobsDir() });
      if (sub === "list") {
        const jobs = store.list().slice(-30).reverse();
        if (flags.has("json"))
          printJson(
            jobs.map((j) => ({
              jobId: j.jobId,
              status: j.status,
              adapter: j.adapter,
              nativeId: j.nativeId,
            })),
          );
        else if (jobs.length === 0) process.stdout.write("no jobs\n");
        else
          for (const j of jobs)
            process.stdout.write(
              `${j.jobId}  ${j.status.padEnd(10)} ${j.originHost}->${j.targetHost}  ${j.adapter.padEnd(22)} ${j.nativeId ?? "-"}\n`,
            );
        return;
      }
      if (sub === "clean") {
        const repoRoot = findRepoRoot(flags.get("repo") as string | undefined);
        const manager = await makeManager(repoRoot, {}, true);
        const dryRun = flags.has("dry-run");
        const cleaned = manager.clean({
          ...(dryRun ? { dryRun: true } : {}),
        });
        if (flags.has("json")) printJson({ ...cleaned, dryRun });
        else
          process.stdout.write(
            `${dryRun ? "would remove" : "removed"} ${cleaned.removed.length} job(s)\n`,
          );
        return;
      }
      if (sub === "recover") {
        const recovered = store.recover();
        process.stdout.write(`recovered ${recovered.length} orphaned job(s)\n`);
        if (flags.has("json")) printJson({ recovered });
        return;
      }
      throw new BridgeError("BRIDGE_USAGE", `unknown jobs subcommand: ${sub}`);
    }

    case "config": {
      const sub = positionals[1] ?? "show";
      if (sub !== "show")
        throw new BridgeError("BRIDGE_USAGE", "config supports only 'show'");
      const repoRoot = findRepoRoot(flags.get("repo") as string | undefined);
      const { loadConfig: lc, redactedConfig: rc } =
        await import("@codex-cursor-bridge/bridge-core");
      const loaded = lc(repoRoot, undefined);
      if (flags.has("json")) {
        printJson({
          config: rc(loaded.config),
          sources: loaded.sources,
          stateRoot: stateRoot(),
          worktreeRoot: defaultWorktreeRoot(),
        });
      } else {
        process.stdout.write(
          `effective configuration (secrets redacted; none stored by design)\n`,
        );
        process.stdout.write(
          `user config:    ${loaded.sources.user ?? "(none)"}\n`,
        );
        process.stdout.write(
          `project config: ${loaded.sources.project ?? "(none)"}\n`,
        );
        process.stdout.write(`state dir:      ${stateRoot()}\n`);
        process.stdout.write(JSON.stringify(rc(loaded.config), null, 2) + "\n");
      }
      return;
    }

    case "demos": {
      const repoRoot = findRepoRoot(flags.get("repo") as string | undefined);
      await runDemos(positionals.slice(1), {
        repoRoot,
        json: flags.has("json"),
      });
      return;
    }

    case "help":
      process.stdout.write(usage() + "\n");
      return;

    default:
      process.stderr.write(usage() + "\n");
      process.exitCode = 1;
      return;
  }
}

if (isCliEntrypoint(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2)).catch((err) => die(err));
}

export { main, isCliEntrypoint };
