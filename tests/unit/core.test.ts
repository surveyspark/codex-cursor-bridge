import { describe, expect, it } from "vitest";
import {
  validateHandoffPlan,
  validateJobResult,
  validateStartRequest,
  redactSecrets,
  redactDeep,
  isSecretEnvName,
  sanitizeBranchName,
  assertRepoRelative,
  assertInsideRepo,
  worktreeDirName,
  canonicalize,
  BridgeError,
  loadConfig,
  assertTransitionSafe,
} from "../helpers.js";

describe("handoff plan validation", () => {
  const validPlan = {
    schemaVersion: "1.0",
    task: "Add a health endpoint",
    goal: "LB liveness",
    observedRepositoryFacts: [
      { fact: "Express app in src/app.ts", evidence: ["src/app.ts:createApp"] },
    ],
    implementationSteps: [
      {
        id: "step-1",
        description: "Add GET /healthz",
        rationale: "required by LB",
        verification: ["npm test"],
      },
    ],
    acceptanceCriteria: ["GET /healthz returns 200"],
    allowedPaths: ["src/**"],
    plannerSummary: "one step",
  };

  it("accepts a valid plan", () => {
    const r = validateHandoffPlan(validPlan);
    expect(r.ok).toBe(true);
  });

  it("rejects schemaVersion mismatch", () => {
    const r = validateHandoffPlan({ ...validPlan, schemaVersion: "2.0" });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.path === "schemaVersion")).toBe(true);
  });

  it("rejects empty observedRepositoryFacts", () => {
    const r = validateHandoffPlan({
      ...validPlan,
      observedRepositoryFacts: [],
    });
    expect(r.ok).toBe(false);
  });

  it("rejects evidence-less facts", () => {
    const r = validateHandoffPlan({
      ...validPlan,
      observedRepositoryFacts: [{ fact: "x", evidence: [] }],
    });
    expect(r.ok).toBe(false);
  });

  it("rejects duplicate step ids", () => {
    const r = validateHandoffPlan({
      ...validPlan,
      implementationSteps: [
        { id: "step-1", description: "a", rationale: "b", verification: ["v"] },
        { id: "step-1", description: "c", rationale: "d", verification: ["v"] },
      ],
    });
    expect(r.ok).toBe(false);
  });

  it("rejects unknown dependsOn references", () => {
    const r = validateHandoffPlan({
      ...validPlan,
      implementationSteps: [
        {
          id: "step-1",
          description: "a",
          rationale: "b",
          dependsOn: ["step-9"],
          verification: ["v"],
        },
      ],
    });
    expect(r.ok).toBe(false);
  });

  it("rejects absolute or traversal allowedPaths", () => {
    for (const bad of ["/etc/passwd", "../out", "C:\\Windows", "a/../../b"]) {
      const r = validateHandoffPlan({ ...validPlan, allowedPaths: [bad] });
      expect(r.ok).toBe(false);
    }
  });

  it("rejects unknown fields", () => {
    const r = validateHandoffPlan({ ...validPlan, extraField: 1 });
    expect(r.ok).toBe(false);
  });

  it("rejects empty acceptanceCriteria", () => {
    const r = validateHandoffPlan({ ...validPlan, acceptanceCriteria: [] });
    expect(r.ok).toBe(false);
  });
});

describe("job result validation", () => {
  it("accepts a minimal valid result", () => {
    const r = validateJobResult({
      jobId: "job_" + "a".repeat(32),
      nativeId: "thr-1",
      adapter: "codex-app-server",
      status: "completed",
      summary: "done",
      continuation: { supported: true, how: "codex_reply" },
    });
    expect(r.ok).toBe(true);
  });

  it("rejects malformed jobId", () => {
    const r = validateJobResult({
      jobId: "nope",
      adapter: "codex-app-server",
      status: "completed",
      summary: "s",
      continuation: { supported: false, how: "n/a" },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects bad adapter names", () => {
    const r = validateJobResult({
      jobId: "job_" + "a".repeat(32),
      adapter: "carrier-pigeon",
      status: "completed",
      summary: "s",
      continuation: { supported: false, how: "n/a" },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects missing continuation", () => {
    const r = validateJobResult({
      jobId: "job_" + "a".repeat(32),
      adapter: "codex-app-server",
      status: "completed",
      summary: "s",
    });
    expect(r.ok).toBe(false);
  });
});

describe("start request validation", () => {
  it("accepts a valid request", () => {
    const r = validateStartRequest({ task: "x", cwd: "/tmp" });
    expect(r.ok).toBe(true);
  });

  it("rejects unknown mode", () => {
    const r = validateStartRequest({
      task: "x",
      cwd: "/tmp",
      mode: "teleport",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects unknown permissionProfile", () => {
    const r = validateStartRequest({
      task: "x",
      cwd: "/tmp",
      permissionProfile: "world-write",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects shell metacharacter injection attempts in fields that get validated lengths only", () => {
    // Task text is data (goes to stdin), so metacharacters are allowed; the
    // validator must NOT reject them but the process layer must never use a shell.
    const r = validateStartRequest({ task: "a; rm -rf /", cwd: "/tmp" });
    expect(r.ok).toBe(true);
  });

  it("rejects a relative cwd", () => {
    const r = validateStartRequest({ task: "x", cwd: "not/absolute" });
    expect(r.ok).toBe(false);
  });

  it("rejects write profiles on read-only modes", () => {
    for (const mode of [
      "investigate",
      "review",
      "adversarial-review",
      "plan",
      "rescue",
    ] as const) {
      for (const permissionProfile of [
        "isolated-workspace-write",
        "current-workspace-write",
      ] as const) {
        const r = validateStartRequest({
          task: "x",
          cwd: "/tmp",
          mode,
          permissionProfile,
        });
        expect(r.ok).toBe(false);
      }
    }
  });

  it("rejects implement + read-only", () => {
    const r = validateStartRequest({
      task: "x",
      cwd: "/tmp",
      mode: "implement",
      permissionProfile: "read-only",
    });
    expect(r.ok).toBe(false);
  });
});

describe("redaction", () => {
  it("redacts OpenAI-style keys", () => {
    const { text } = redactSecrets("key sk-abcdefghijklmnop123456 end");
    expect(text).not.toContain("sk-abcdefghijklmnop123456");
    expect(text).toContain("***REDACTED***");
  });

  it("redacts bearer tokens", () => {
    const { text } = redactSecrets(
      "Authorization: Bearer abc.def.ghi-jkl-1234567890",
    );
    expect(text).toContain("***REDACTED***");
    expect(text).not.toContain("abc.def.ghi-jkl-1234567890");
  });

  it("redacts Authorization Basic credentials", () => {
    const { text } = redactSecrets("Authorization: Basic dXNlcjpwYXNzd29yZA==");
    expect(text).toContain("***REDACTED***");
    expect(text).not.toContain("dXNlcjpwYXNzd29yZA==");
  });

  it("redacts secret-named keys in objects", () => {
    const out = redactDeep({
      OPENAI_API_KEY: "sk-secret-value-123456",
      ok: "fine",
    });
    expect(out.OPENAI_API_KEY).toBe("***REDACTED***");
    expect(out.ok).toBe("fine");
  });

  it("redacts private keys", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\nMIIdef\n-----END RSA PRIVATE KEY-----";
    const { text } = redactSecrets(`before ${pem} after`);
    expect(text).toContain("***REDACTED-PRIVATE-KEY***");
    expect(text).not.toContain("MIIabc");
  });

  it("redacts cookies and jwt", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const { text } = redactSecrets(`set-cookie: session=${jwt}; x=${jwt}`);
    expect(text).toContain("***REDACTED***");
    expect(text).not.toContain("SflKxwRJSMeKKF2");
  });

  it("redacts password assignments", () => {
    const { text } = redactSecrets(
      "password: hunter2secret api_key = 'abcdef123456'",
    );
    expect(text).toContain("***REDACTED***");
    expect(text).not.toContain("hunter2secret");
  });

  it("redacts nested structures", () => {
    const out = redactDeep({ a: { b: ["sk-abcdefghijklmnop123456"] } });
    expect(JSON.stringify(out)).not.toContain("sk-abcdefghijklmnop123456");
  });

  it("flags secret env names", () => {
    expect(isSecretEnvName("OPENAI_API_KEY")).toBe(true);
    expect(isSecretEnvName("MY_SERVICE_TOKEN")).toBe(true);
    expect(isSecretEnvName("PATH")).toBe(false);
    expect(isSecretEnvName("HOME")).toBe(false);
  });
});

describe("path safety", () => {
  it("sanitizes malicious branch names", () => {
    expect(sanitizeBranchName("feature/../..--evil")).not.toContain("..");
    expect(sanitizeBranchName("a b c")).toBe("a-b-c");
    expect(sanitizeBranchName("--dash-start")).not.toMatch(/^-/);
    expect(sanitizeBranchName("lock")).not.toBe("lock.lock");
    const out = sanitizeBranchName("release^:v1?.lock");
    expect(out).not.toMatch(/[\^:?*[\]\\~]/);
  });

  it("rejects traversal in repo-relative paths", () => {
    expect(() => assertRepoRelative("../x")).toThrow(BridgeError);
    expect(() => assertRepoRelative("/abs")).toThrow(BridgeError);
    expect(() => assertRepoRelative("a/b")).not.toThrow();
    expect(() => assertRepoRelative(".")).not.toThrow();
  });

  it("containment check works", () => {
    const root = canonicalize(process.cwd());
    expect(() => assertInsideRepo(root, root)).not.toThrow();
    expect(() => assertInsideRepo(root, root + "/sub/x")).not.toThrow();
    expect(() => assertInsideRepo(root, "/etc")).toThrow(BridgeError);
  });

  it("worktree dir names are filesystem safe", () => {
    const name = worktreeDirName(
      "/repo/my project",
      "job_0123456789abcdef0123456789abcdef",
      "feature/with:colon",
    );
    expect(name).not.toMatch(/[:\s]/);
    expect(name).toContain("01234567");
  });
});

describe("job state transitions", () => {
  it("allows queued -> starting", () => {
    expect(() => assertTransitionSafe("queued", "starting")).not.toThrow();
  });
  it("rejects queued -> completed", () => {
    expect(() => assertTransitionSafe("queued", "completed")).toThrow(
      /invalid job status transition/,
    );
  });
  it("rejects completed -> anything", () => {
    expect(() => assertTransitionSafe("completed", "running")).toThrow();
    expect(() => assertTransitionSafe("completed", "failed")).toThrow();
  });
  it("allows running -> terminal states", () => {
    for (const s of [
      "completed",
      "failed",
      "cancelled",
      "timed-out",
    ] as const) {
      expect(() => assertTransitionSafe("running", s)).not.toThrow();
    }
  });
  it("allows waiting states back to running", () => {
    expect(() =>
      assertTransitionSafe("waiting-for-approval", "running"),
    ).not.toThrow();
    expect(() =>
      assertTransitionSafe("waiting-for-input", "running"),
    ).not.toThrow();
  });
});

describe("config precedence", () => {
  it("defaults are conservative", () => {
    const { config } = loadConfig(null);
    expect(config.maxHandoffDepth).toBe(1);
    expect(config.networkPolicy).toBe("denied");
    expect(config.defaultPermissionProfile).toBe("read-only");
    expect(config.debugLogging).toBe(false);
    expect(config.allowNonInteractiveCliFallback).toBe(false);
  });
});
