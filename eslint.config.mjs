import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/bundles/**",
      "**/coverage/**",
      "**/release/**",
      "**/tests/fixtures/**",
      "codex-cursor-bridge-task.md",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": "off",
      eqeqeq: ["error", "smart"],
      "no-throw-literal": "error",
    },
  },
  {
    files: ["**/*.test.ts", "tests/**/*.ts", "**/test-support/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
