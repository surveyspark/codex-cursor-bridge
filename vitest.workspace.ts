import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      name: "unit",
      include: ["tests/unit/**/*.test.ts"],
      environment: "node",
      testTimeout: 20_000,
    },
  },
  {
    test: {
      name: "protocol",
      include: ["tests/protocol/**/*.test.ts"],
      environment: "node",
      testTimeout: 30_000,
    },
  },
  {
    test: {
      name: "contract",
      include: ["tests/contract/**/*.test.ts"],
      environment: "node",
      testTimeout: 30_000,
    },
  },
  {
    test: {
      name: "integration",
      include: ["tests/integration/**/*.test.ts"],
      environment: "node",
      testTimeout: 60_000,
    },
  },
  {
    test: {
      name: "security",
      include: ["tests/security/**/*.test.ts"],
      environment: "node",
      testTimeout: 30_000,
    },
  },
]);
