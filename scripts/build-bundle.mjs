/**
 * Build script: type-emitted output lives in packages dist (tsc -b);
 * this script bundles the CLI into a single runnable file at
 * bundles/codex-cursor-bridge.mjs via esbuild so release archives and
 * plugin manifests can reference one portable executable.
 */

import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

fs.mkdirSync(path.join(root, "bundles"), { recursive: true });

// The CLI imports @cursor/sdk only dynamically; mark it external so the
// bundle never tries to resolve an optional peer at build time.
await build({
  entryPoints: [path.join(root, "packages/cli/src/index.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: path.join(root, "bundles/codex-cursor-bridge.mjs"),
  banner: {
    js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
  },
  external: ["@cursor/sdk"],
  legalComments: "inline",
  sourcemap: false,
  minify: false,
  logLevel: "info",
});

// Non-bundle build also needs the workspace bin executable.
fs.chmodSync(path.join(root, "bundles/codex-cursor-bridge.mjs"), 0o755);
console.log("bundle written: bundles/codex-cursor-bridge.mjs");
