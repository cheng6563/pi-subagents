import { test } from "node:test";
import assert from "node:assert/strict";
import { parameters, validateParams } from "../src/parameters.ts";

test("launch options carry real settings while minimal calls stay minimal", () => {
	assert.deepEqual(validateParams({ task: "task", async: false }), { task: "task", async: false });
	const input = { task: "task", options: { requirementsFile: "要求.md", model: "shared:lowCost", maxDepth: 2, context: "fresh", cwd: ".", timeoutMs: 1000 } };
	assert.deepEqual(validateParams(input), input);
	assert.deepEqual(validateParams({ action: "resume", id: "run", async: false }), { action: "resume", id: "run", async: false });
	assert.equal(parameters.properties.options.additionalProperties, true);
	assert.deepEqual(Object.keys(parameters.properties.options.properties), ["requirementsFile", "model", "maxDepth", "context", "cwd", "timeoutMs"]);
});

test("open transport schema does not accept unsupported settings at execution", () => {
	for (const options of [
		{ unknown: true }, { model: 1 }, { maxDepth: 0 }, { maxDepth: 1.5 },
		{ timeoutMs: 0 }, { context: "profile" }, { cwd: "" }, { requirementsFile: false },
		{ async: false }, { model: "" }, null, [], "model=x",
	]) assert.throws(() => validateParams({ task: "task", options }));
	for (const input of [{ task: "task", model: "x" }, { task: "task", maxDepth: 2 }, { action: "unknown" }, { task: "task", async: "false" }]) {
		assert.throws(() => validateParams(input), /Invalid subagent parameters/);
	}
});
