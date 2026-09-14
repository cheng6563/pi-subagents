import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { discoverAgentsAll } from "../../src/agents/agents.ts";
import { resolvePiLaunchToolPlan } from "../../src/runs/shared/child-tool-plan.ts";
import { checkSubagentDepth, resolveChildMaxSubagentDepth } from "../../src/shared/types.ts";

it("native builtins inherit normal tools and ambient extensions without authorizing fanout", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-native-tools-"));
	try {
		const agents = discoverAgentsAll(cwd).builtin.filter(agent => !agent.runner || agent.runner.type === "pi");
		assert.deepEqual(agents.map(agent => agent.name).sort(), ["delegate", "evidence-auditor", "oracle", "researcher", "reviewer", "scout", "worker"]);
		for (const agent of agents) {
			const plan = resolvePiLaunchToolPlan({
				cwd,
				agentName: agent.name,
				tools: agent.tools,
				excludeTools: agent.excludeTools,
				extensions: agent.extensions,
				allowNestedSubagents: agent.allowNestedSubagents,
			});
			assert.equal(plan.explicitToolAllowlist, false, agent.name);
			assert.equal(plan.disableAmbientExtensions, false, agent.name);
			assert.equal(plan.fanoutAuthorized, false, agent.name);
			assert.deepEqual(plan.excludeTools, ["subagent"], agent.name);
			assert.deepEqual(plan.requiredChildTools, [], agent.name);
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

it("subagent exclusion prevents a tool override from enabling fanout", () => {
	const plan = resolvePiLaunchToolPlan({
		tools: ["read", "bash", "subagent"],
		excludeTools: ["subagent"],
		allowNestedSubagents: true,
	});
	assert.equal(plan.fanoutAuthorized, false);
	assert.deepEqual(plan.effectiveToolAllowlist, ["read", "bash"]);
});

it("a one-level operator limit permits parent launches but blocks further child launches", () => {
	assert.equal(checkSubagentDepth(1, { depth: 0, maxDepth: 1 }).blocked, false);
	const childLimit = resolveChildMaxSubagentDepth(1, 9);
	assert.equal(childLimit, 1);
	assert.deepEqual(checkSubagentDepth(9, { depth: 1, maxDepth: childLimit }), { blocked: true, depth: 1, maxDepth: 1 });
});
