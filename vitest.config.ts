import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      // Tests load package `dist/` (the shipped path). v8 remaps to src via
      // source maps, so include dist and exclude CLI entry/demo surfaces.
      include: [
        "packages/*/dist/**/*.js",
        "packages/cli/src/{origin,doctor,shared}.ts",
      ],
      exclude: [
        "**/*.map",
        "**/*.d.ts",
        "packages/cli/src/index.ts",
        "packages/cli/src/demos.ts",
        "packages/*/src/types.ts",
        "packages/test-support/**",
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        statements: 70,
        branches: 60,
      },
    },
  },
});
