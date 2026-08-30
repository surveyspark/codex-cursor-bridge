/**
 * Plugin manifest validation: checks both plugin manifests against their
 * documented schemas and verifies skill frontmatter.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const errors: string[] = [];

function validateCursorPlugin(pluginDir: string): void {
  const manifestPath = path.join(pluginDir, ".cursor-plugin", "plugin.json");
  if (!fs.existsSync(manifestPath)) {
    errors.push(`missing ${manifestPath}`);
    return;
  }
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  } catch (err) {
    errors.push(`${manifestPath}: invalid JSON (${(err as Error).message})`);
    return;
  }
  for (const field of ["name", "version", "description"]) {
    if (typeof m[field] !== "string" || (m[field] as string).length === 0) {
      errors.push(`${manifestPath}: missing/invalid "${field}"`);
    }
  }
  if (typeof m.name === "string" && !/^[a-z0-9-]+$/.test(m.name)) {
    errors.push(`${manifestPath}: "name" must be kebab-case`);
  }
  // skills
  const skillsDir = path.join(pluginDir, "skills");
  if (!fs.existsSync(skillsDir)) errors.push(`${pluginDir}: missing skills/ directory`);
  else validateSkills(skillsDir);
  // commands frontmatter
  const commandsDir = path.join(pluginDir, "commands");
  if (fs.existsSync(commandsDir)) {
    for (const f of fs.readdirSync(commandsDir)) {
      if (!f.endsWith(".md")) continue;
      const text = fs.readFileSync(path.join(commandsDir, f), "utf8");
      if (!text.startsWith("---")) errors.push(`${commandsDir}/${f}: missing YAML frontmatter`);
      else {
        const end = text.indexOf("---", 3);
        const fm = text.slice(3, end);
        if (!/name:/.test(fm) || !/description:/.test(fm)) {
          errors.push(`${commandsDir}/${f}: frontmatter requires name and description`);
        }
      }
    }
  }
}

function validateCodexPlugin(pluginDir: string): void {
  const manifestPath = path.join(pluginDir, ".codex-plugin", "plugin.json");
  if (!fs.existsSync(manifestPath)) {
    errors.push(`missing ${manifestPath}`);
    return;
  }
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  } catch (err) {
    errors.push(`${manifestPath}: invalid JSON (${(err as Error).message})`);
    return;
  }
  for (const field of ["name", "version", "description"]) {
    if (typeof m[field] !== "string" || (m[field] as string).length === 0) {
      errors.push(`${manifestPath}: missing/invalid "${field}"`);
    }
  }
  if (typeof m.name === "string" && !/^[a-z0-9-]+$/.test(m.name)) {
    errors.push(`${manifestPath}: "name" must be kebab-case`);
  }
  const skillsDir = path.join(pluginDir, "skills");
  if (!fs.existsSync(skillsDir)) errors.push(`${pluginDir}: missing skills/ directory`);
  else validateSkills(skillsDir);
}

function validateSkills(skillsDir: string): void {
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillMd = path.join(skillsDir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillMd)) {
      errors.push(`skills/${entry.name}: missing SKILL.md`);
      continue;
    }
    const text = fs.readFileSync(skillMd, "utf8");
    if (!text.startsWith("---")) {
      errors.push(`skills/${entry.name}/SKILL.md: missing frontmatter`);
      continue;
    }
    const end = text.indexOf("---", 3);
    const fm = text.slice(3, end);
    const nameMatch = /name:\s*"?([a-z0-9-]+)"?/.exec(fm);
    if (!nameMatch) {
      errors.push(`skills/${entry.name}/SKILL.md: frontmatter "name" missing or not kebab-case`);
    } else if (nameMatch[1] !== entry.name) {
      errors.push(`skills/${entry.name}/SKILL.md: frontmatter name "${nameMatch[1]}" != directory name`);
    }
    if (!/description:/.test(fm) || fm.split("description:")[1]?.trim().length === 0) {
      errors.push(`skills/${entry.name}/SKILL.md: frontmatter "description" required`);
    }
  }
}

validateCursorPlugin(path.join(root, "plugins/cursor-delegates-to-codex"));
validateCodexPlugin(path.join(root, "plugins/codex-plans-cursor-executes"));

// JSON Schemas parse
for (const f of ["handoff-plan.schema.json", "job-record.schema.json", "result.schema.json", "config.schema.json"]) {
  const p = path.join(root, "schemas", f);
  try {
    JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (err) {
    errors.push(`schemas/${f}: invalid JSON (${(err as Error).message})`);
  }
}

if (errors.length > 0) {
  console.error("manifest validation FAILED:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log("plugin manifests and schemas OK");
