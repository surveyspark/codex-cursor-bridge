/**
 * Canonical JSON schema validation helpers.
 *
 * The bridge validates handoff plans, job records, results, and start
 * requests at runtime. Rather than pulling a full JSON Schema runtime into
 * every package, we use a small strict validator for the subsets this
 * project needs, with schemas stored as JSON documents in `schemas/` and
 * compiled invariants in code (single source of truth: the JSON Schemas).
 *
 * For the plan contract specifically we implement a complete structural
 * validator that matches `schemas/handoff-plan.schema.json`.
 */

import { BridgeError } from "./errors.js";
import type { HandoffPlan, JobResult, StartRequest } from "./types.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  issues: ValidationIssue[];
}

function issue(path: string, message: string): ValidationIssue {
  return { path, message };
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strLimit(v: unknown, max: number): boolean {
  return isString(v) && v.length <= max;
}

function strArrayLimit(v: unknown, maxItems: number, maxLen: number): boolean {
  return (
    Array.isArray(v) &&
    v.length <= maxItems &&
    v.every((x) => strLimit(x, maxLen))
  );
}

/**
 * Validate an object against the handoff plan contract.
 * Mirrors schemas/handoff-plan.schema.json (draft 2020-12 subset).
 */
export function validateHandoffPlan(raw: unknown): ValidationResult<HandoffPlan> {
  const issues: ValidationIssue[] = [];

  if (!isObject(raw)) {
    return { ok: false, issues: [issue("$", "plan must be a JSON object")] };
  }
  const p = raw as Record<string, unknown>;

  if (p.schemaVersion !== "1.0") {
    issues.push(issue("schemaVersion", 'must be "1.0"'));
  }
  if (!strLimit(p.task, 20000) || !isNonEmptyString(p.task)) {
    issues.push(issue("task", "required non-empty string (max 20000)"));
  }
  if (!strLimit(p.goal, 5000) || !isNonEmptyString(p.goal)) {
    issues.push(issue("goal", "required non-empty string (max 5000)"));
  }
  if (p.nonGoals !== undefined && !strArrayLimit(p.nonGoals, 50, 2000)) {
    issues.push(issue("nonGoals", "array of strings (max 50)"));
  }
  if (!Array.isArray(p.observedRepositoryFacts) || p.observedRepositoryFacts.length < 1 || p.observedRepositoryFacts.length > 200) {
    issues.push(issue("observedRepositoryFacts", "required array with 1..200 items"));
  } else {
    p.observedRepositoryFacts.forEach((f, i) => {
      if (!isObject(f)) {
        issues.push(issue(`observedRepositoryFacts[${i}]`, "must be an object"));
        return;
      }
      const fact = f as Record<string, unknown>;
      if (!strLimit(fact.fact, 2000) || !isNonEmptyString(fact.fact)) {
        issues.push(issue(`observedRepositoryFacts[${i}].fact`, "required non-empty string"));
      }
      if (!Array.isArray(fact.evidence) || fact.evidence.length < 1 || fact.evidence.length > 20 || !fact.evidence.every((e) => strLimit(e, 1000) && isNonEmptyString(e))) {
        issues.push(issue(`observedRepositoryFacts[${i}].evidence`, "required array of 1..20 non-empty strings"));
      }
    });
  }
  if (p.assumptions !== undefined && !strArrayLimit(p.assumptions, 50, 2000)) {
    issues.push(issue("assumptions", "array of strings (max 50)"));
  }
  if (p.constraints !== undefined && !strArrayLimit(p.constraints, 50, 2000)) {
    issues.push(issue("constraints", "array of strings (max 50)"));
  }
  if (!Array.isArray(p.implementationSteps) || p.implementationSteps.length < 1 || p.implementationSteps.length > 100) {
    issues.push(issue("implementationSteps", "required array with 1..100 steps"));
  } else {
    const ids = new Set<string>();
    p.implementationSteps.forEach((s, i) => {
      if (!isObject(s)) {
        issues.push(issue(`implementationSteps[${i}]`, "must be an object"));
        return;
      }
      const step = s as Record<string, unknown>;
      const id = step.id;
      if (!isString(id) || !/^step-[0-9]+$/.test(id) || id.length > 32) {
        issues.push(issue(`implementationSteps[${i}].id`, 'must match "step-<number>"'));
      } else {
        if (ids.has(id)) {
          issues.push(issue(`implementationSteps[${i}].id`, "duplicate step id"));
        }
        ids.add(id);
      }
      if (!strLimit(step.description, 5000) || !isNonEmptyString(step.description)) {
        issues.push(issue(`implementationSteps[${i}].description`, "required non-empty string"));
      }
      if (!strLimit(step.rationale, 5000) || !isNonEmptyString(step.rationale)) {
        issues.push(issue(`implementationSteps[${i}].rationale`, "required non-empty string"));
      }
      if (step.likelyFiles !== undefined && !strArrayLimit(step.likelyFiles, 100, 1024)) {
        issues.push(issue(`implementationSteps[${i}].likelyFiles`, "array of strings (max 100)"));
      }
      if (step.dependsOn !== undefined) {
        if (!Array.isArray(step.dependsOn) || !step.dependsOn.every((d) => isString(d) && /^step-[0-9]+$/.test(d))) {
          issues.push(issue(`implementationSteps[${i}].dependsOn`, 'array of "step-<number>" ids'));
        } else {
          for (const d of step.dependsOn as string[]) {
            if (!ids.has(d) && d !== id) {
              // forward reference: validate later; here only mark unknown if it can never exist
            }
          }
        }
      }
      if (!Array.isArray(step.verification) || step.verification.length < 1 || step.verification.length > 20 || !step.verification.every((v) => strLimit(v, 1000) && isNonEmptyString(v))) {
        issues.push(issue(`implementationSteps[${i}].verification`, "required array of 1..20 non-empty strings"));
      }
    });
    // dependsOn must reference declared ids
    if (issues.length === 0) {
      for (const s of p.implementationSteps as Array<Record<string, unknown>>) {
        for (const d of (s.dependsOn as string[] | undefined) ?? []) {
          if (!ids.has(d)) {
            issues.push(issue(`implementationSteps[${s.id as string}].dependsOn`, `unknown step id "${d}"`));
          }
        }
      }
    }
  }
  if (!Array.isArray(p.acceptanceCriteria) || p.acceptanceCriteria.length < 1 || p.acceptanceCriteria.length > 50 || !p.acceptanceCriteria.every((a) => strLimit(a, 2000) && isNonEmptyString(a))) {
    issues.push(issue("acceptanceCriteria", "required array of 1..50 non-empty strings"));
  }
  if (p.testPlan !== undefined && !strArrayLimit(p.testPlan, 50, 1000)) {
    issues.push(issue("testPlan", "array of strings (max 50)"));
  }
  if (p.risks !== undefined) {
    if (!Array.isArray(p.risks) || p.risks.length > 50) {
      issues.push(issue("risks", "array (max 50)"));
    } else {
      p.risks.forEach((r, i) => {
        if (!isObject(r)) {
          issues.push(issue(`risks[${i}]`, "must be an object"));
          return;
        }
        const risk = r as Record<string, unknown>;
        if (!strLimit(risk.risk, 2000) || !isNonEmptyString(risk.risk)) {
          issues.push(issue(`risks[${i}].risk`, "required non-empty string"));
        }
        if (!strLimit(risk.mitigation, 2000) || !isNonEmptyString(risk.mitigation)) {
          issues.push(issue(`risks[${i}].mitigation`, "required non-empty string"));
        }
      });
    }
  }
  if (p.rollbackPlan !== undefined && !strArrayLimit(p.rollbackPlan, 20, 1000)) {
    issues.push(issue("rollbackPlan", "array of strings (max 20)"));
  }
  if (!Array.isArray(p.allowedPaths) || p.allowedPaths.length < 1 || p.allowedPaths.length > 200 || !p.allowedPaths.every((a) => strLimit(a, 1024) && isNonEmptyString(a))) {
    issues.push(issue("allowedPaths", "required array of 1..200 non-empty strings"));
  } else {
    for (const a of p.allowedPaths as string[]) {
      if (/^([A-Za-z]:|\/)/.test(a) || a.includes("..")) {
        issues.push(issue("allowedPaths", `path "${a}" must be repo-relative and must not traverse upward`));
      }
    }
  }
  if (p.forbiddenActions !== undefined && !strArrayLimit(p.forbiddenActions, 50, 2000)) {
    issues.push(issue("forbiddenActions", "array of strings (max 50)"));
  }
  if (!strLimit(p.plannerSummary, 10000) || !isNonEmptyString(p.plannerSummary)) {
    issues.push(issue("plannerSummary", "required non-empty string (max 10000)"));
  }
  if (p.generatedBy !== undefined && !strLimit(p.generatedBy, 200)) {
    issues.push(issue("generatedBy", "string (max 200)"));
  }
  if (p.generatedAt !== undefined && !(isString(p.generatedAt) && !Number.isNaN(Date.parse(p.generatedAt)))) {
    issues.push(issue("generatedAt", "must be an ISO-8601 date-time"));
  }

  // unknown keys are rejected (additionalProperties: false)
  const known = new Set([
    "schemaVersion", "task", "goal", "nonGoals", "observedRepositoryFacts",
    "assumptions", "constraints", "implementationSteps", "acceptanceCriteria",
    "testPlan", "risks", "rollbackPlan", "allowedPaths", "forbiddenActions",
    "plannerSummary", "generatedBy", "generatedAt",
  ]);
  for (const k of Object.keys(p)) {
    if (!known.has(k)) {
      issues.push(issue(k, "unknown field"));
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, value: p as unknown as HandoffPlan, issues };
}

const ADAPTER_NAMES = new Set([
  "codex-app-server",
  "codex-exec-fallback",
  "cursor-sdk",
  "cursor-acp",
  "cursor-cli-fallback",
]);

const MODES = new Set([
  "investigate", "review", "adversarial-review", "rescue", "plan", "implement",
]);

const PROFILES = new Set([
  "read-only", "isolated-workspace-write", "current-workspace-write",
]);

/** Structural validation for job result payloads (schemas/result.schema.json). */
export function validateJobResult(raw: unknown): ValidationResult<JobResult> {
  const issues: ValidationIssue[] = [];
  if (!isObject(raw)) {
    return { ok: false, issues: [issue("$", "result must be a JSON object")] };
  }
  const r = raw as Record<string, unknown>;
  if (!isString(r.jobId) || !/^job_[0-9a-f]{32}$/.test(r.jobId)) {
    issues.push(issue("jobId", "must match job_[0-9a-f]{32}"));
  }
  if (r.nativeId !== null && r.nativeId !== undefined && (!isString(r.nativeId) || r.nativeId.length > 200)) {
    issues.push(issue("nativeId", "string (max 200) or null"));
  }
  if (!isString(r.adapter) || !ADAPTER_NAMES.has(r.adapter)) {
    issues.push(issue("adapter", "unknown adapter name"));
  }
  if (!isString(r.status) || !["completed", "failed", "cancelled", "timed-out"].includes(r.status)) {
    issues.push(issue("status", "invalid terminal status"));
  }
  if (!strLimit(r.summary, 10000) || !isNonEmptyString(r.summary)) {
    issues.push(issue("summary", "required non-empty string (max 10000)"));
  }
  const optionalStrArrays: Array<[string, number, number]> = [
    ["findings", 100, 4000],
    ["warnings", 100, 4000],
    ["blockers", 100, 4000],
    ["residualRisks", 100, 4000],
  ];
  for (const [k, maxItems, maxLen] of optionalStrArrays) {
    if (r[k] !== undefined && !strArrayLimit(r[k], maxItems, maxLen)) {
      issues.push(issue(k, `array of strings (max ${maxItems})`));
    }
  }
  const known = new Set([
    "jobId", "nativeId", "adapter", "status", "summary", "findings",
    "changedFiles", "diffStat", "diffPatchPath", "commands", "tests",
    "approvals", "warnings", "blockers", "residualRisks", "artifacts",
    "continuation", "startedAt", "finishedAt", "failure",
  ]);
  for (const k of Object.keys(r)) {
    if (!known.has(k)) issues.push(issue(k, "unknown field"));
  }
  if (r.continuation !== undefined) {
    if (!isObject(r.continuation)) {
      issues.push(issue("continuation", "must be an object"));
    } else {
      const c = r.continuation as Record<string, unknown>;
      if (typeof c.supported !== "boolean") {
        issues.push(issue("continuation.supported", "boolean required"));
      }
      if (!strLimit(c.how, 2000) || !isNonEmptyString(c.how)) {
        issues.push(issue("continuation.how", "required non-empty string"));
      }
    }
  } else {
    issues.push(issue("continuation", "required object {supported, how}"));
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: r as unknown as JobResult, issues };
}

/** Validate a start request coming from MCP tools or CLI. */
export function validateStartRequest(raw: unknown): ValidationResult<StartRequest> {
  const issues: ValidationIssue[] = [];
  if (!isObject(raw)) {
    return { ok: false, issues: [issue("$", "start request must be a JSON object")] };
  }
  const s = raw as Record<string, unknown>;
  if (!strLimit(s.task, 40000) || !isNonEmptyString(s.task)) {
    issues.push(issue("task", "required non-empty string (max 40000)"));
  }
  if (!isNonEmptyString(s.cwd)) {
    issues.push(issue("cwd", "required non-empty string"));
  }
  if (s.mode !== undefined && (!isString(s.mode) || !MODES.has(s.mode))) {
    issues.push(issue("mode", "unknown delegation mode"));
  }
  if (s.permissionProfile !== undefined && (!isString(s.permissionProfile) || !PROFILES.has(s.permissionProfile))) {
    issues.push(issue("permissionProfile", "unknown permission profile"));
  }
  if (s.background !== undefined && typeof s.background !== "boolean") {
    issues.push(issue("background", "must be boolean"));
  }
  if (s.model !== undefined && (!isString(s.model) || s.model.length > 200 || s.model.length === 0)) {
    issues.push(issue("model", "string (max 200)"));
  }
  if (s.reasoningEffort !== undefined && s.reasoningEffort !== null && !["low", "medium", "high", "xhigh"].includes(s.reasoningEffort as string)) {
    issues.push(issue("reasoningEffort", "one of low|medium|high|xhigh"));
  }
  if (s.timeoutMs !== undefined && s.timeoutMs !== null && (typeof s.timeoutMs !== "number" || (s.timeoutMs as number) < 1000)) {
    issues.push(issue("timeoutMs", "number >= 1000"));
  }
  if (s.constraints !== undefined && !strArrayLimit(s.constraints, 50, 2000)) {
    issues.push(issue("constraints", "array of strings (max 50)"));
  }
  const known = new Set([
    "task", "cwd", "mode", "permissionProfile", "background", "model",
    "reasoningEffort", "baseRef", "worktreePreference", "timeoutMs", "origin",
    "constraints", "expectedOutput",
  ]);
  for (const k of Object.keys(s)) {
    if (!known.has(k)) issues.push(issue(k, "unknown field"));
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: s as unknown as StartRequest, issues };
}

export function planValidationError(partial: { task?: unknown } | unknown): BridgeError {
  const vr = validateHandoffPlan(partial);
  const detail = vr.issues.map((i) => `${i.path}: ${i.message}`).join("; ");
  return new BridgeError("PLAN_INVALID", `handoff plan failed validation: ${detail}`, {
    details: vr.issues,
  });
}
