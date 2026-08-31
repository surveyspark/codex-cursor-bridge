/**
 * Normalization of Codex thread items into bridge result fields.
 *
 * Item kinds (verified 0.145.0 ThreadItem oneOf): userMessage, hookPrompt,
 * agentMessage, plan, reasoning, commandExecution, fileChange, mcpToolCall,
 * webSearch, error, and others. Unknown kinds are preserved as "other".
 */

export type NormalizedCommand = {
  command: string;
  exitCode?: number | null;
  aggregatedStatus: "success" | "failure" | "unknown";
};

export type NormalizedChangedFile = {
  path: string;
  change: "added" | "modified" | "deleted" | "renamed";
};

export function extractCommands(
  items: Array<{ item: Record<string, unknown>; kind: string }>,
): NormalizedCommand[] {
  const out: NormalizedCommand[] = [];
  for (const { item, kind } of items) {
    if (kind === "commandExecution") {
      const command =
        typeof item.command === "string"
          ? item.command
          : String(item.command ?? "");
      const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
      out.push({
        command,
        exitCode,
        aggregatedStatus:
          exitCode === null
            ? "unknown"
            : exitCode === 0
              ? "success"
              : "failure",
      });
    }
  }
  return out.slice(0, 200);
}

export function extractChangedFiles(
  items: Array<{ item: Record<string, unknown>; kind: string }>,
): NormalizedChangedFile[] {
  const out: NormalizedChangedFile[] = [];
  const seen = new Set<string>();
  for (const { item, kind } of items) {
    if (kind !== "fileChange") continue;
    const changes = item.changes;
    if (!Array.isArray(changes)) continue;
    for (const c of changes) {
      const rec = c as Record<string, unknown>;
      const pathValue =
        typeof rec.path === "string"
          ? rec.path
          : typeof rec.file === "string"
            ? rec.file
            : null;
      if (!pathValue || seen.has(pathValue)) continue;
      seen.add(pathValue);
      let change: NormalizedChangedFile["change"] = "modified";
      const kindField = rec.kind ?? rec.type;
      if (kindField === "add" || kindField === "added") change = "added";
      else if (kindField === "delete" || kindField === "deleted")
        change = "deleted";
      else if (kindField === "update" || kindField === "modified")
        change = "modified";
      else if (
        kindField === "move" ||
        kindField === "renamed" ||
        kindField === "move_path"
      )
        change = "renamed";
      out.push({ path: pathValue, change });
    }
  }
  return out.slice(0, 500);
}

/** Extract test-ish outcomes from executed commands (heuristic, documented). */
export function extractTests(
  commands: NormalizedCommand[],
): Array<{ name: string; outcome: "passed" | "failed" | "unknown" }> {
  const testLike =
    /(^|\s|\/)(npm (test|run test)|npx vitest|npx jest|pytest|cargo test|go test|make test|npx tsc)(\s|$)/i;
  return commands
    .filter((c) => testLike.test(c.command))
    .slice(0, 50)
    .map((c) => ({
      name: c.command,
      outcome:
        c.aggregatedStatus === "success"
          ? "passed"
          : c.aggregatedStatus === "failure"
            ? "failed"
            : "unknown",
    }));
}
