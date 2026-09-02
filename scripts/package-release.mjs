/**
 * Release packaging: produces release archives under release/.
 * Deterministic-ish: timestamps inside staged copies are normalized to a
 * fixed epoch. Staged directories remain (gitignored); no destructive ops.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
).version;
const releaseDir = path.join(root, "release");
const stageDir = path.join(releaseDir, "stage");

fs.rmSync(releaseDir, { recursive: true, force: true });
fs.mkdirSync(releaseDir, { recursive: true });
fs.mkdirSync(stageDir, { recursive: true });

const FIXED_STAMP = new Date("2026-01-01T00:00:00Z");

function normalizeTimes(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) normalizeTimes(p);
    else fs.utimesSync(p, FIXED_STAMP, FIXED_STAMP);
  }
  fs.utimesSync(dir, FIXED_STAMP, FIXED_STAMP);
}

async function zipStaged(stagedPath, outZip) {
  normalizeTimes(stagedPath);
  await execFileAsync(
    "zip",
    ["-X", "-r", "-q", path.resolve(outZip), path.basename(stagedPath)],
    {
      cwd: path.dirname(stagedPath),
      timeout: 120000,
    },
  );
}

// 1. CLI bundle archive
const cliStage = path.join(stageDir, "codex-cursor-bridge");
fs.mkdirSync(cliStage, { recursive: true });
fs.copyFileSync(
  path.join(root, "bundles/codex-cursor-bridge.mjs"),
  path.join(cliStage, "codex-cursor-bridge.mjs"),
);
fs.copyFileSync(path.join(root, "LICENSE"), path.join(cliStage, "LICENSE"));
fs.copyFileSync(path.join(root, "NOTICE"), path.join(cliStage, "NOTICE"));
fs.copyFileSync(path.join(root, "README.md"), path.join(cliStage, "README.md"));
fs.copyFileSync(
  path.join(root, "scripts/install.sh"),
  path.join(cliStage, "install.sh"),
);
fs.copyFileSync(
  path.join(root, "scripts/install.ps1"),
  path.join(cliStage, "install.ps1"),
);
fs.chmodSync(path.join(cliStage, "codex-cursor-bridge.mjs"), 0o755);
fs.chmodSync(path.join(cliStage, "install.sh"), 0o755);
fs.cpSync(
  path.join(root, "plugins"),
  path.join(cliStage, "plugins"),
  { recursive: true },
);
await zipStaged(
  cliStage,
  path.join(releaseDir, `codex-cursor-bridge-cli-${version}.zip`),
);

// 2. Plugin archives (staged so zips contain a top-level folder)
const cursorPluginStage = path.join(
  stageDir,
  "codex-cursor-bridge-plugin-cursor",
);
fs.cpSync(
  path.join(root, "plugins/cursor-delegates-to-codex"),
  cursorPluginStage,
  { recursive: true },
);
await zipStaged(
  cursorPluginStage,
  path.join(releaseDir, `codex-cursor-bridge-plugin-cursor-${version}.zip`),
);

const codexPluginStage = path.join(
  stageDir,
  "codex-cursor-bridge-plugin-codex",
);
fs.cpSync(
  path.join(root, "plugins/codex-plans-cursor-executes"),
  codexPluginStage,
  { recursive: true },
);
await zipStaged(
  codexPluginStage,
  path.join(releaseDir, `codex-cursor-bridge-plugin-codex-${version}.zip`),
);

// 3. Checksums
const artifacts = fs
  .readdirSync(releaseDir)
  .filter((f) => f.endsWith(".zip"))
  .sort();
const lines = [];
for (const f of artifacts) {
  const hash = createHash("sha256")
    .update(fs.readFileSync(path.join(releaseDir, f)))
    .digest("hex");
  lines.push(`${hash}  ${f}`);
}
fs.writeFileSync(path.join(releaseDir, "SHA256SUMS"), lines.join("\n") + "\n");

// 4. SBOM (CycloneDX subset derived from package-lock.json)
const lock = JSON.parse(
  fs.readFileSync(path.join(root, "package-lock.json"), "utf8"),
);
const components = Object.entries(lock.packages || {})
  .filter(([k]) => k.startsWith("node_modules/"))
  .map(([k, v]) => ({
    type: "library",
    name: k.replace(/^node_modules\//, ""),
    version: v.version || "unknown",
  }));
const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  metadata: {
    component: { type: "application", name: "codex-cursor-bridge", version },
  },
  components,
};
fs.writeFileSync(
  path.join(releaseDir, `sbom-codex-cursor-bridge-${version}.json`),
  JSON.stringify(sbom, null, 2) + "\n",
);

console.log("release artifacts written to release/:");
for (const f of fs.readdirSync(releaseDir).sort()) console.log(`  ${f}`);
