import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resolveSharedModelReference } from "../../src/shared/shared-models.ts";
import { buildModelCandidates, resolveEffectiveSubagentModel, resolveSubagentModelOverride } from "../../src/runs/shared/model-fallback.ts";
import { resolveSubagentLaunchContract } from "../../src/api/preflight.ts";

const availableModels = [
	{ provider: "cheap", id: "small", fullId: "cheap/small" },
	{ provider: "other", id: "next", fullId: "other/next" },
	{ provider: "main", id: "large", fullId: "main/large" },
];
const parentModel = { provider: "main", id: "large" };

describe("shared primary model references", () => {
	let root: string;
	let previousAgentDir: string | undefined;
	let configFile: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-shared-models-"));
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = root;
		configFile = join(root, "shared-models.json");
		writeFileSync(configFile, JSON.stringify({ lowCost: { provider: "cheap", model: "small" }, analysis: { provider: "other", model: "next" } }), "utf8");
	});
	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	});

	it("resolves arbitrary names and thinking without changing the configuration", () => {
		const before = readFileSync(configFile, "utf8");
		assert.equal(resolveSharedModelReference("shared:lowCost"), "cheap/small");
		assert.equal(resolveSharedModelReference("shared:analysis:low"), "other/next:low");
		assert.equal(readFileSync(configFile, "utf8"), before);
	});

	it("keeps literal keys that end in a known thinking name", () => {
		writeFileSync(configFile, JSON.stringify({ high: { provider: "cheap", model: "small" }, "analysis:low": { provider: "other", model: "next" } }), "utf8");
		assert.equal(resolveSharedModelReference("shared:high"), "cheap/small");
		assert.equal(resolveSharedModelReference("shared:analysis:low"), "other/next");
	});

	it("does not read shared configuration for ordinary models or inheritance", () => {
		writeFileSync(configFile, "not JSON", "utf8");
		assert.equal(resolveSharedModelReference("cheap/small"), "cheap/small");
		assert.equal(resolveSubagentModelOverride("inherit", parentModel, availableModels), "main/large");
	});

	it("fails missing files, unknown names and malformed entries instead of inheriting the parent", () => {
		for (const value of ["shared:", "shared:missing", "shared:LowCost"]) {
			assert.throws(() => resolveSubagentModelOverride(value, parentModel, availableModels), /Unknown shared model/);
		}
		for (const value of ["not JSON", "[]", '{"lowCost":{"model":"small"}}', '{"lowCost":{"provider":" ","model":"small"}}']) {
			writeFileSync(configFile, value, "utf8");
			assert.throws(() => resolveSharedModelReference("shared:lowCost"), /shared model|unable to read/);
		}
		rmSync(configFile);
		assert.throws(() => resolveSharedModelReference("shared:lowCost"), /unable to read/);
	});

	it("uses normal explicit precedence and model-scope enforcement after expansion", () => {
		assert.equal(resolveEffectiveSubagentModel(undefined, "shared:lowCost", parentModel, availableModels), "cheap/small");
		assert.equal(resolveEffectiveSubagentModel("other/next", "shared:lowCost", parentModel, availableModels), "other/next");
		assert.equal(resolveEffectiveSubagentModel("shared:analysis", "cheap/small", parentModel, availableModels), "other/next");
		assert.throws(() => resolveSubagentModelOverride("shared:lowCost", parentModel, availableModels, undefined, {
			source: "explicit", scope: { enforce: true, allow: ["main/*"] },
		}), /scope|allowed/i);
	});

	it("reads new selections on new launches while a resolved primary remains fixed", () => {
		const primary = resolveSubagentModelOverride("shared:lowCost", parentModel, availableModels);
		writeFileSync(configFile, JSON.stringify({ lowCost: { provider: "other", model: "next" } }), "utf8");
		assert.equal(resolveSubagentModelOverride("shared:lowCost", parentModel, availableModels), "other/next");
		assert.equal(resolveSubagentModelOverride(primary, parentModel, availableModels), "cheap/small");
		assert.deepEqual(buildModelCandidates(primary, ["other/next"], availableModels), ["cheap/small", "other/next"]);
	});

	it("projects a concrete primary model through public launch preflight", async () => {
		const cwd = join(root, "project");
		const agentDir = join(cwd, ".pi", "agents");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "reader.md"), "---\nname: reader\ndescription: Shared model reader fixture\nmodel: shared:lowCost\ntools: read\nthinking: low\n---\nRead the assigned file.\n", "utf8");
		const result = await resolveSubagentLaunchContract({ agent: "reader", cwd, parentModel, availableModels });
		assert.equal(result.ok, true, JSON.stringify(result));
		if (!result.ok) return;
		assert.equal(result.contract.model, "cheap/small:low");
		assert.deepEqual(result.contract.modelCandidates, ["cheap/small:low"]);
		const overridden = await resolveSubagentLaunchContract({ agent: "reader", cwd, model: "shared:analysis:high", parentModel, availableModels });
		assert.equal(overridden.ok, true, JSON.stringify(overridden));
		if (!overridden.ok) return;
		assert.equal(overridden.contract.model, "other/next:high");
	});
});
