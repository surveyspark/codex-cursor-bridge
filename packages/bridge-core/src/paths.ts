/**
 * Path safety: canonicalization, repository containment, symlink escape
 * protection, and safe repo-relative path checks.
 */

import fs from "node:fs";
import path from "node:path";
import { BridgeError } from "./errors.js";

/**
 * Resolve to a canonical absolute path (realpath when possible).
 * Falls back to lexical normalization when the path does not exist.
 */
export function canonicalize(p: string): string {
  const abs = path.isAbsolute(p) ? p : path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    // Path may not exist yet; normalize lexically.
    return path.normalize(abs);
  }
}

/** True when `child` equals or is inside `root` (both canonical). */
export function isInside(root: string, child: string): boolean {
  const rel = path.relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function assertInsideRepo(
  repoRoot: string,
  target: string,
  label = "path",
): string {
  const root = canonicalize(repoRoot);
  const canon = canonicalize(target);
  if (!isInside(root, canon)) {
    throw new BridgeError(
      "PATH_OUTSIDE_REPOSITORY",
      `${label} "${target}" resolves outside the repository root "${repoRoot}"`,
      { details: { repoRoot: root, target: canon } },
    );
  }
  return canon;
}

/**
 * Validate a repo-relative path fragment used in plans, worktrees, or output
 * filters. Rejects absolute paths and upward traversal.
 */
export function assertRepoRelative(p: string): string {
  if (p === ".") return ".";
  if (path.isAbsolute(p) || /^[A-Za-z]:/.test(p)) {
    throw new BridgeError(
      "PATH_OUTSIDE_REPOSITORY",
      `path "${p}" must be repository-relative`,
    );
  }
  const norm = path.normalize(p);
  if (norm === ".." || norm.startsWith(`..${path.sep}`)) {
    throw new BridgeError(
      "PATH_ESCAPE",
      `path "${p}" must not traverse upward`,
    );
  }
  if (norm.split(path.sep).includes("..")) {
    throw new BridgeError(
      "PATH_ESCAPE",
      `path "${p}" must not contain ".." segments`,
    );
  }
  return norm;
}

/**
 * Detect whether any component of the path (that exists) is a symlink that
 * escapes `repoRoot`. Returns the canonical path when safe.
 */
export function assertNoSymlinkEscape(
  repoRoot: string,
  target: string,
): string {
  const root = canonicalize(repoRoot);
  const abs = path.isAbsolute(target) ? target : path.resolve(root, target);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new BridgeError(
      "PATH_OUTSIDE_REPOSITORY",
      `target "${target}" is outside the repository`,
    );
  }
  // Walk each component and realpath-check.
  const parts = rel === "" ? [] : rel.split(path.sep);
  let cur = root;
  for (const part of parts) {
    cur = path.join(cur, part);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch {
      continue; // does not exist yet
    }
    if (st.isSymbolicLink()) {
      const resolved = canonicalize(cur);
      if (!isInside(root, resolved)) {
        throw new BridgeError(
          "PATH_ESCAPE",
          `symlink "${path.relative(root, cur)}" escapes the repository root`,
          { details: { resolved } },
        );
      }
    }
  }
  return canonicalize(abs);
}

/** Build a unique, collision-resistant worktree directory name. */
export function worktreeDirName(
  repoRoot: string,
  jobId: string,
  baseRef: string,
): string {
  const repoName = path
    .basename(canonicalize(repoRoot))
    .replace(/[^A-Za-z0-9._-]/g, "-");
  const ref = baseRef.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40) || "base";
  const short = jobId.replace(/^job_/, "").slice(0, 8);
  return `${repoName}-${ref}-${short}`;
}

/**
 * Sanitize a git branch name according to git-check-ref-format rules that
 * matter in practice (no leading dashes, no spaces, no ~^:?*[\, no ..,
 * cannot end with .lock or /).
 */
export function sanitizeBranchName(input: string): string {
  let name = input.trim().toLowerCase().replace(/\s+/g, "-");
  name = name.replace(/[^A-Za-z0-9._/-]/g, "-");
  name = name.replace(/\.\./g, "-");
  name = name.replace(/^[.\-/]+/, "");
  name = name.replace(/[./-]+$/, "");
  name = name.replace(/\.lock$/i, "");
  name = name.replace(/\^|\?|\*|\[|\\|:|~/g, "-");
  name = name.slice(0, 120);
  if (!name) name = "bridge-branch";
  return name;
}
