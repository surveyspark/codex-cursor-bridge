# Handoff plan field guide

The plan is a contract between you (planner) and Cursor (executor). Every
field is validated against `schemas/handoff-plan.schema.json`.

## Field-by-field

| Field                     | Required | Notes                                                                               |
| ------------------------- | -------- | ----------------------------------------------------------------------------------- |
| `schemaVersion`           | yes      | always `"1.0"`                                                                      |
| `task`                    | yes      | the user's original task; ≤20000 chars                                              |
| `goal`                    | yes      | one crisp sentence                                                                  |
| `nonGoals`                | no       | prevents scope creep by the executor                                                |
| `observedRepositoryFacts` | yes (≥1) | `fact` + `evidence[]`; evidence must be a path, symbol, or command you actually ran |
| `assumptions`             | no       | things you did NOT verify — the executor will verify                                |
| `constraints`             | no       | styles, frameworks, migration rules                                                 |
| `implementationSteps`     | yes (≥1) | ordered; `dependsOn` references earlier `step-N` ids                                |
| `acceptanceCriteria`      | yes (≥1) | checkable statements; the diff is judged against these                              |
| `testPlan`                | no       | commands like `npm test -- --run src/api`                                           |
| `risks`                   | no       | risk + mitigation pairs                                                             |
| `rollbackPlan`            | no       | how to undo (e.g. `git checkout -- src/api/user.ts`)                                |
| `allowedPaths`            | yes (≥1) | repo-relative globs; `"."` or `"packages/**"` style; never absolute                 |
| `forbiddenActions`        | no       | e.g. "no dependency upgrades", "no schema migrations"                               |
| `plannerSummary`          | yes      | human-readable summary shown to the user                                            |

## Common validation failures

1. `allowedPaths` contains absolute paths or `..` — always repo-relative.
2. `dependsOn` references unknown step ids.
3. `observedRepositoryFacts` evidence is vague ("the code seems to") — cite
   `path:symbol` or a command.
4. Steps without `verification` — every step needs at least one check.
5. Empty `acceptanceCriteria` — "tests pass" is not checkable; name the tests.

## Minimal example

```json
{
  "schemaVersion": "1.0",
  "task": "Add /healthz endpoint returning {status:'ok'}",
  "goal": "Add a liveness endpoint for the load balancer",
  "observedRepositoryFacts": [
    {
      "fact": "Express app is created in src/app.ts",
      "evidence": ["src/app.ts:createApp"]
    },
    {
      "fact": "Route tests live in test/routes.test.ts",
      "evidence": ["test/routes.test.ts"]
    }
  ],
  "assumptions": ["No auth middleware on new routes is acceptable"],
  "implementationSteps": [
    {
      "id": "step-1",
      "description": "Add GET /healthz returning 200 {status:'ok'}",
      "rationale": "Load balancer requires a liveness probe",
      "likelyFiles": ["src/app.ts", "test/routes.test.ts"],
      "dependsOn": [],
      "verification": ["npm test -- --run test/routes.test.ts"]
    }
  ],
  "acceptanceCriteria": [
    "GET /healthz returns 200 and {\"status\":\"ok\"}",
    "existing route tests still pass"
  ],
  "testPlan": ["npm test -- --run test/routes.test.ts"],
  "risks": [
    { "risk": "route conflict", "mitigation": "place handler before catch-all" }
  ],
  "rollbackPlan": ["git checkout -- src/app.ts test/routes.test.ts"],
  "allowedPaths": ["src/app.ts", "test/routes.test.ts"],
  "forbiddenActions": ["no new dependencies"],
  "plannerSummary": "Single endpoint addition with one test file touched."
}
```
