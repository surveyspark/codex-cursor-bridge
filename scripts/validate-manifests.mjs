/**
 * Plugin manifest validation: checks both plugin manifests against their
 * documented schemas and verifies skill frontmatter.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const errors = [];

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    errors.push(`${file}: invalid JSON (${err.message})`);
    return null;
  }
}

function validateSkillDir(skillsDir, prefix) {
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillMd = path.join(skillsDir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillMd)) {
      errors.push(`${prefix}/skills/${entry.name}: missing SKILL.md`);
      continue;
    }
    const text = fs.readFileSync(skillMd, "utf8");
    if (!text.startsWith("---")) {
      errors.push(`${prefix}/skills/${entry.name}/SKILL.md: missing frontmatter`);
      continue;
    }
    const end = text.indexOf("---", 3);
    const fm = text.slice(3, end);
    const nameMatch = /name:\s*"?([a-z0-9-]+)"?/.exec(fm);
    if (!nameMatch) {
      errors.push(`${prefix}/skills/${entry.name}/SKILL.md: frontmatter "name" missing or not kebab-case`);
    } else if (nameMatch[1] !== entry.name) {
      errors.push(`${prefix}/skills/${entry.name}/SKILL.md: frontmatter name "${nameMatch[1]}" != directory name`);
    }
    const descMatch = /description:/.test(fm);
    if (!descMatch || fm.split("description:")[1]?.trim().length === 0) {
      errors.push(`${prefix}/skills/${entry.name}/SKILL.md: frontmatter "description" required`);
    }
  }
}

function validateCommon(pluginDir, manifestSubDir, prefix) {
  const manifestPath = path.join(pluginDir, manifestSubDir, "plugin.json");
  if (!fs.existsSync(manifestPath)) {
    errors.push(`missing ${manifestPath}`);
    return null;
  }
  const m = readJsonSafe(manifestPath);
  if (!m) return null;
  for (const field of ["name", "version", "description"]) {
    if (typeof m[field] !== "string" || m[field].length === 0) {
      errors.push(`${manifestPath}: missing/invalid "${field}"`);
    }
  }
  if (typeof m.name === "string" && !/^[a-z0-9-]+$/.test(m.name)) {
    errors.push(`${manifestPath}: "name" must be kebab-case`);
  }
  const skillsDir = path.join(pluginDir, "skills");
  if (!fs.existsSync(skillsDir)) {
    errors.push(`${pluginDir}: missing skills/ directory`);
  } else {
    validateSkillDir(skillsDir, prefix);
  }
  return m;
}

function validateCommands(pluginDir) {
  const commandsDir = path.join(pluginDir, "commands");
  if (!fs.existsSync(commandsDir)) return;
  for (const f of fs.readdirSync(commandsDir)) {
    if (!f.endsWith(".md")) continue;
    const text = fs.readFileSync(path.join(commandsDir, f), "utf8");
    if (!text.startsWith("---")) {
      errors.push(`commands/${f}: missing YAML frontmatter`);
      continue;
    }
    const end = text.indexOf("---", 3);
    const fm = text.slice(3, end);
    if (!/name:/.test(fm) || !/description:/.test(fm)) {
      errors.push(`commands/${f}: frontmatter requires name and description`);
    }
  }
}

// Cursor plugin
const cursorDir = path.join(root, "plugins/cursor-delegates-to-codex");
if (validateCommon(cursorDir, ".cursor-plugin", "cursor-plugin")) {
  validateCommands(cursorDir);
}

// Codex plugin
const codexDir = path.join(root, "plugins/codex-plans-cursor-executes");
validateCommon(codexDir, ".codex-plugin", "codex-plugin");

// JSON Schemas parse
for (const f of ["handoff-plan.schema.json", "job-record.schema.json", "result.schema.json", "config.schema.json"]) {
  readJsonSafe(path.join(root, "schemas", f));
}

if (errors.length > 0) {
  console.error("manifest validation FAILED:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log("plugin manifests and schemas OK");
