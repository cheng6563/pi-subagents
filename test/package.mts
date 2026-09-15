import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { resolveHostPeerAliases } from "../src/runs/background/runner-aliases.ts";

const host = process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT;
assert.ok(host, "Host Pi SDK path is required");
const { aliases, missing } = resolveHostPeerAliases(host);
assert.deepEqual(missing, []);
const jiti = createJiti(import.meta.url, { alias: aliases });
const sdk = await jiti.import<any>("@earendil-works/pi-coding-agent");
const repository = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(join(repository, "package.json"), "utf8"));
assert.equal(Object.hasOwn(manifest.pi, "skills"), false);
assert.ok(!manifest.files.some((file: string) => file.startsWith("skills/")));
assert.equal(existsSync(join(repository, "skills", "pi-subagents", "SKILL.md")), false);
const root = mkdtempSync(join(tmpdir(), "subagents-package-"));
const agentDir = join(root, "agent");
const businessSkill = join(agentDir, "skills", "fixture-business");
mkdirSync(businessSkill, { recursive: true });
writeFileSync(join(businessSkill, "SKILL.md"), "---\nname: fixture-business\ndescription: Test normal independent business skill discovery.\n---\nKeep business methods outside the executor.\n", "utf8");
const loader = new sdk.DefaultResourceLoader({
  cwd: root, agentDir,
  settingsManager: sdk.SettingsManager.inMemory({ packages: [repository] }),
  noContextFiles: true, noPromptTemplates: true, noThemes: true,
});
await loader.reload();
const loaded = loader.getExtensions();
assert.deepEqual(loaded.errors, []);
const extension = loaded.extensions.find((entry: any) => entry.tools.has("subagent"));
assert.ok(extension, "Local package must load the executor through its manifest");
assert.ok(extension.commands.has("subagents"));
const definition = extension.tools.get("subagent").definition;
assert.match(definition.parameters.properties.action.description, /interrupt pauses and permits resume/);
assert.match(definition.parameters.properties.action.description, /cancel terminates and cannot be resumed/);
assert.match(definition.parameters.properties.async.description, /without an extra completion notice/);
assert.match(definition.description, /original loaded Markdown snapshot/);
const skills = loader.getSkills().skills.map((skill: any) => skill.name);
assert.ok(skills.includes("fixture-business"), "Independent business skills must still load");
assert.ok(!skills.includes("pi-subagents"), "No redundant usage skill should be advertised");
writeFileSync(join(root, "results.json"), JSON.stringify({ passed: true, skills, commands: [...extension.commands.keys()], description: definition.description, parameters: definition.parameters }, null, 2), "utf8");
console.log(`PACKAGE_WITHOUT_USAGE_SKILL_PASS ${root}`);
