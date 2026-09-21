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
assert.match(definition.parameters.properties.action.description, /interrupt.*resumable/);
assert.match(definition.parameters.properties.action.description, /cancel.*final/);
assert.match(definition.parameters.properties.async.description, /false.*no extra notice/);
const contract = JSON.stringify({ description: definition.description, parameters: definition.parameters });
assert.doesNotMatch(contract, /README\.md|Before use, read/);
for (const rule of [/coordinate shared-file writes/, /inspect status and recent output/, /wait if running/, /resume only if resumable/, /without renewed approval/, /do not replay completed side effects/, /Honor user stops/, /no-progress failures/]) assert.match(definition.description, rule);
const p = definition.parameters.properties;
for (const action of ['list/status', 'result', 'wait', 'interrupt', 'cancel', 'resume', 'steer', 'report']) assert.ok(p.action.description.includes(action));
assert.match(p.action.description, /aborting wait does not stop the run/);
assert.match(p.action.description, /resume keeps original requirements, model, depth, cwd and context/);
assert.match(p.options.description, /Management\/resume rejects task and options/);
assert.match(p.options.properties.requirementsFile.description, /relative to caller cwd.*snapshot reused on resume/);
assert.match(p.options.properties.maxDepth.description, /inherit\/cannot increase/);
assert.match(p.options.properties.context.description, /no parent history\/system prompt/);
assert.match(p.options.properties.model.description, /no fallback/);
assert.match(p.async.description, /aborting wait restores async notification/);
const skills = loader.getSkills().skills.map((skill: any) => skill.name);
assert.ok(skills.includes("fixture-business"), "Independent business skills must still load");
assert.ok(!skills.includes("pi-subagents"), "No redundant usage skill should be advertised");
writeFileSync(join(root, "results.json"), JSON.stringify({ passed: true, skills, commands: [...extension.commands.keys()], description: definition.description, parameters: definition.parameters }, null, 2), "utf8");
console.log(`PACKAGE_WITHOUT_USAGE_SKILL_PASS ${root}`);
