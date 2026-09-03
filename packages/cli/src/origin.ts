/**
 * CLI-family origin mapping. `cursor start` must target Cursor, not Codex:
 * origin.host is always "cli", and targetHost is the command family.
 */

export type CliCommandHost = "codex" | "cursor";

export function cliJobOrigin(host: CliCommandHost): {
  host: "cli";
  tool: "cli";
  client: "terminal";
  targetHost: CliCommandHost;
} {
  return {
    host: "cli",
    tool: "cli",
    client: "terminal",
    targetHost: host,
  };
}

export function jobsForCliHost<T extends { targetHost: string }>(
  jobs: readonly T[],
  host: CliCommandHost,
): T[] {
  return jobs.filter((j) => j.targetHost === host);
}
