import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childDepth, readRequirements, selectModel, requirementsPrompt, validateContract, type Contract } from "../src/contract.ts";
import { createRun, readContract, lockResume } from "../src/store.ts";
import { commandBlockReason, toolCommandBlockReason } from "../src/guard.ts";

const model = { provider: "test", id: "parent", thinking: "off" as const };
function contract(cwd: string): Contract { return { version: 1, task: "task", cwd, model, context: "fresh", depth: childDepth(undefined), timeoutMs: 1000 }; }

test("default depth is one; explicit descendants inherit and cannot grow/reset ceiling", () => {
	assert.deepEqual(childDepth(undefined), { depth: 1, maxDepth: 1 });
	assert.throws(() => childDepth(childDepth(undefined)), /exhausted/);
	const first = childDepth(undefined, 3);
	const second = childDepth(first);
	assert.deepEqual(second, { depth: 2, maxDepth: 3 });
	assert.deepEqual(childDepth(second), { depth: 3, maxDepth: 3 });
	assert.throws(() => childDepth(first, 4), /Cannot increase/);
	assert.throws(() => childDepth(second, 1), /exhausted/);
	for (const value of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => childDepth(undefined, value));
});

test("exact parent model inherits; unavailable selections never fall back", () => {
	assert.deepEqual(selectModel(undefined, model, "high", [model]), { ...model, thinking: "high" });
	assert.deepEqual(selectModel("test/parent:low", undefined, "off", [model]), { ...model, thinking: "low" });
	assert.throws(() => selectModel(undefined, undefined, "off", [model]), /Parent model/);
	assert.throws(() => selectModel("test/missing", model, "off", [model]), /no fallback/);
});

test("shared:lowCost uses existing resolver, errors on missing/invalid/unavailable config", () => {
	const dir = mkdtempSync(join(tmpdir(), "subagent-model-test-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		assert.throws(() => selectModel("shared:lowCost", model, "off", [model]), /unable to read/);
		writeFileSync(join(dir, "shared-models.json"), JSON.stringify({ lowCost: { provider: "test", model: "cheap" } }), "utf8");
		const available = [model, { provider: "test", id: "cheap" }];
		assert.deepEqual(selectModel("shared:lowCost", model, "low", available), { provider: "test", id: "cheap", thinking: "low" });
		assert.throws(() => selectModel("shared:lowCost", model, "off", [model]), /unavailable/);
		assert.throws(() => selectModel("shared:absent", model, "off", available), /Unknown shared model/);
		writeFileSync(join(dir, "shared-models.json"), "{}oops", "utf8");
		assert.throws(() => selectModel("shared:lowCost", model, "off", available), /unable to read/);
	} finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(dir, { recursive: true, force: true }); }
});

test("UTF-8 Markdown snapshot is durable across mutation/deletion; invalid reads fail before launch", () => {
	const dir = mkdtempSync(join(tmpdir(), "subagent-md-test-"));
	try {
		const file = join(dir, "要求.md");
		writeFileSync(file, "\uFEFF# 要求\n只返回原要求。", "utf8");
		const snapshot = readRequirements("要求.md", dir);
		assert.match(snapshot.text, /只返回原要求/);
		const c = { ...contract(dir), requirements: snapshot };
		const run = createRun(join(dir, "runs"), c);
		writeFileSync(file, "CHANGED", "utf8");
		assert.deepEqual(readContract(run), c);
		rmSync(file);
		assert.match(requirementsPrompt(readContract(run)), /只返回原要求/);
		assert.throws(() => readRequirements("要求.md", dir), /Cannot load requirementsFile/);
		writeFileSync(file, Buffer.from([0xff, 0xfe, 0x61]));
		assert.throws(() => readRequirements(file, dir), /UTF-8|encoded data/);
		mkdirSync(join(dir, "folder.md"));
		assert.throws(() => readRequirements("folder.md", dir), /not a regular file/);
		assert.throws(() => readRequirements("no.txt", dir), /Markdown/);
		const release = lockResume(run);
		assert.throws(() => lockResume(run), /already being resumed/); release();
		assert.throws(() => validateContract({ agent: "reviewer" }), /old role-based/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI and script launch guard blocks direct, interpreter, nested script, package and remote paths", () => {
	const dir = mkdtempSync(join(tmpdir(), "subagent-guard-test-"));
	try {
		for (const cmd of ['pi -p hello', 'env -u PI_SUBAGENT_CHILD pi --no-extensions -p hi', '"C:/node/pi.cmd" -p hi', 'python3 -c "import subprocess; subprocess.run([\'pi\', \'-p\', \'hi\'])"', 'node -e "createAgentSession()"', 'ssh host "codex exec hi"']) assert.ok(commandBlockReason(cmd, dir), cmd);
		writeFileSync(join(dir, "inner.py"), "import subprocess\nsubprocess.run(['pi', '-p', 'task'])", "utf8");
		writeFileSync(join(dir, "outer.sh"), "python3 inner.py", "utf8");
		assert.ok(commandBlockReason("bash outer.sh", dir));
		writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node ./inner.py" } }), "utf8");
		assert.ok(commandBlockReason("npm test", dir));
		assert.ok(toolCommandBlockReason("cascade_remote_bash", { command: "pi -p task" }, dir));
		assert.equal(commandBlockReason("git status --short", dir), undefined);
		assert.equal(commandBlockReason("python3 -c 'print(2 + 2)'", dir), undefined);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
