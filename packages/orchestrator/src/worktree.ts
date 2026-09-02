/**
 * Git worktree isolation for implementation jobs.
 *
 * - Creates a temporary worktree from a clearly recorded base reference.
 * - Never touches uncommitted work in the developer's current tree.
 * - Never merges automatically; produces a patch artifact + diff summary.
 * - Cleans up only on explicit request or retention.
 * - Repos that are not git, or have no initial commit, throw
 *   WORKTREE_CREATE_FAILED (isolation is required for this path).
 */

import {
  BridgeError,
  canonicalize,
  sanitizeBranchName,
} from "@codex-cursor-bridge/bridge-core";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorktreeCreated {
  path: string;
  branch: string;
  baseRef: string;
  created: boolean;
}

export interface GitInfo {
  isGit: boolean;
  hasCommits: boolean;
  root: string | null;
  version: string | null;
  branch: string | null;
  dirty: boolean;
}

export async function gitVersion(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["--version"], {
      timeout: 10_000,
    });
    return stdout.trim().replace(/^git version\s*/, "");
  } catch {
    return null;
  }
}

/** Inspect a directory for git usability. Never throws. */
export async function inspectGit(cwd: string): Promise<GitInfo> {
  const info: GitInfo = {
    isGit: false,
    hasCommits: false,
    root: null,
    version: await gitVersion(),
    branch: null,
    dirty: false,
  };
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd, timeout: 10_000 },
    );
    info.isGit = true;
    info.root = canonicalize(stdout.trim());
  } catch {
    return info;
  }
  try {
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd, timeout: 10_000 });
    info.hasCommits = true;
  } catch {
    info.hasCommits = false;
  }
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["branch", "--show-current"],
      { cwd, timeout: 10_000 },
    );
    info.branch = stdout.trim() || null;
  } catch {
    info.branch = null;
  }
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd,
      timeout: 15_000,
    });
    info.dirty = stdout.trim().length > 0;
  } catch {
    info.dirty = false;
  }
  return info;
}

export interface CreateWorktreeOptions {
  repoRoot: string;
  worktreeRoot: string;
  jobId: string;
  baseRef?: string;
  /** Existing repos need a branch name; sanitized then suffixed with the job short id. */
  branchPrefix?: string;
}

export async function createWorktree(
  opts: CreateWorktreeOptions,
): Promise<WorktreeCreated> {
  const info = await inspectGit(opts.repoRoot);
  if (!info.isGit || !info.root) {
    throw new BridgeError(
      "WORKTREE_CREATE_FAILED",
      "repository is not a git work tree; worktree isolation unavailable",
    );
  }
  if (!info.hasCommits) {
    throw new BridgeError(
      "WORKTREE_CREATE_FAILED",
      "repository has no commits yet; commit (or choose current-workspace-write) before delegating implementation",
    );
  }
  fs.mkdirSync(opts.worktreeRoot, { recursive: true, mode: 0o700 });

  // Resolve base ref: explicit > current branch > HEAD, then pin to a SHA
  // so later commits on that branch cannot reverse-diff the patch.
  const requested = opts.baseRef ?? info.branch ?? "HEAD";
  let baseRef: string;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--verify", `${requested}^{commit}`],
      {
        cwd: opts.repoRoot,
        timeout: 10_000,
      },
    );
    baseRef = stdout.trim();
  } catch {
    if (opts.baseRef) {
      throw new BridgeError(
        "WORKTREE_CREATE_FAILED",
        `base ref "${opts.baseRef}" does not resolve to a commit`,
      );
    }
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--verify", "HEAD"],
      { cwd: opts.repoRoot, timeout: 10_000 },
    );
    baseRef = stdout.trim();
  }

  const short = opts.jobId.replace(/^job_/, "").slice(0, 8);
  const repoName = path.basename(info.root).replace(/[^A-Za-z0-9._-]/g, "-");
  const branch = sanitizeBranchName(
    `${opts.branchPrefix ?? "bridge"}/${repoName}-${short}`,
  );
  const wtPath = path.join(opts.worktreeRoot, `${repoName}-${short}`);

  if (
    fs.existsSync(wtPath) ||
    fs.existsSync(
      path.join(info.root, ".git", "worktrees", path.basename(wtPath)),
    )
  ) {
    throw new BridgeError(
      "WORKTREE_EXISTS",
      `worktree path already exists: ${wtPath}`,
    );
  }

  try {
    await execFileAsync(
      "git",
      ["worktree", "add", "--detach", wtPath, baseRef],
      { cwd: opts.repoRoot, timeout: 60_000 },
    );
    // Try to create a named branch for the result.
    await execFileAsync("git", ["checkout", "-b", branch], {
      cwd: wtPath,
      timeout: 30_000,
    });
  } catch (err) {
    // Roll back partial creation.
    try {
      await execFileAsync("git", ["worktree", "remove", "--force", wtPath], {
        cwd: opts.repoRoot,
        timeout: 30_000,
      });
    } catch {
      /* best effort */
    }
    throw new BridgeError(
      "WORKTREE_CREATE_FAILED",
      `git worktree add failed: ${(err as Error).message}`,
      { cause: err },
    );
  }

  return { path: wtPath, branch, baseRef, created: true };
}

export interface WorktreeDiffSummary {
  filesChanged: number;
  insertions: number;
  deletions: number;
  patchPath: string | null;
  files: Array<{
    path: string;
    change: "added" | "modified" | "deleted" | "renamed";
  }>;
}

/** Collect diff vs base ref inside a worktree; writes a patch artifact into .handoff/. */
export async function collectWorktreeDiff(
  wt: WorktreeCreated,
  repoRoot: string,
  maxOutputBytes: number,
): Promise<WorktreeDiffSummary> {
  const empty: WorktreeDiffSummary = {
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
    patchPath: null,
    files: [],
  };
  try {
    // Include untracked files in the stat by adding intent-to-add? Never touch
    // the index destructively; use status + numstat instead.
    await execFileAsync("git", ["add", "-N", "."], {
      cwd: wt.path,
      timeout: 30_000,
    }).catch(() => undefined);
    const numstat = await execFileAsync(
      "git",
      ["diff", "--numstat", wt.baseRef],
      {
        cwd: wt.path,
        timeout: 30_000,
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    const status = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: wt.path,
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const files: WorktreeDiffSummary["files"] = [];
    // Primary source: numstat vs base ref (works for committed AND uncommitted changes).
    for (const line of numstat.stdout.split("\n")) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (!m) continue;
      files.push({ path: m[3]!.trim(), change: "modified" });
    }
    // Plus untracked files (not in numstat).
    for (const line of status.stdout.split("\n")) {
      if (!line.startsWith("??")) continue;
      const file = line.slice(3).trim().replace(/^"|"$/, "");
      if (file && !files.some((f) => f.path === file))
        files.push({ path: file, change: "added" });
    }
    let insertions = 0;
    let deletions = 0;
    for (const line of numstat.stdout.split("\n")) {
      const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
      if (m) {
        insertions += m[1] === "-" ? 0 : parseInt(m[1]!, 10);
        deletions += m[2] === "-" ? 0 : parseInt(m[2]!, 10);
      }
    }
    // Export patch into the project's .handoff directory.
    let patchPath: string | null = null;
    try {
      const { stdout: diffOut } = await execFileAsync(
        "git",
        ["diff", wt.baseRef],
        {
          cwd: wt.path,
          timeout: 60_000,
          maxBuffer: 1024 * 1024 * 1024,
        },
      );
      const truncated =
        Buffer.byteLength(diffOut, "utf8") > maxOutputBytes
          ? diffOut.slice(0, maxOutputBytes) +
            "\n…[truncated by maxOutputBytes]"
          : diffOut;
      if (truncated.trim().length > 0) {
        const handoff = path.join(repoRoot, ".handoff");
        fs.mkdirSync(handoff, { recursive: true });
        const patchFile = path.join(handoff, `${path.basename(wt.path)}.patch`);
        fs.writeFileSync(patchFile, truncated, { mode: 0o600 });
        patchPath = path.relative(repoRoot, patchFile);
      }
    } catch {
      patchPath = null;
    }
    return {
      filesChanged: files.length,
      insertions,
      deletions,
      patchPath,
      files: files.slice(0, 500),
    };
  } catch {
    return empty;
  }
}

/** Remove a worktree (explicit cleanup path only). */
export async function removeWorktree(
  repoRoot: string,
  wtPath: string,
): Promise<void> {
  await execFileAsync("git", ["worktree", "remove", wtPath], {
    cwd: repoRoot,
    timeout: 60_000,
  });
}

/** Parse `git diff --numstat` style summary for the current tree (non-worktree runs). */
export async function collectCurrentDiffSummary(
  repoRoot: string,
  baseRef: string | null,
  maxOutputBytes: number,
): Promise<WorktreeDiffSummary> {
  const args = baseRef
    ? ["diff", "--numstat", baseRef]
    : ["diff", "--numstat", "HEAD"];
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoRoot,
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    let insertions = 0;
    let deletions = 0;
    for (const line of stdout.split("\n")) {
      const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
      if (m) {
        insertions += m[1] === "-" ? 0 : parseInt(m[1]!, 10);
        deletions += m[2] === "-" ? 0 : parseInt(m[2]!, 10);
      }
    }
    const status = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: repoRoot,
      timeout: 30_000,
    });
    const files = status.stdout
      .split("\n")
      .filter((l) => l.trim().length >= 4)
      .map((l) => ({
        path: l.slice(3).trim().replace(/^"|"$/g, ""),
        change:
          l.slice(0, 2).trim() === "??" || l.slice(0, 2).trim() === "A"
            ? ("added" as const)
            : l.slice(0, 2).trim() === "D"
              ? ("deleted" as const)
              : ("modified" as const),
      }));
    return {
      filesChanged: files.length,
      insertions,
      deletions,
      patchPath: null,
      files: files.slice(0, 500),
    };
  } catch {
    return {
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      patchPath: null,
      files: [],
    };
  }
  void maxOutputBytes;
}
