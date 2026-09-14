import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { discoverAgentsAll } from "../../src/agents/agents.ts";
import { resolvePiLaunchToolPlan } from "../../src/runs/shared/child-tool-plan.ts";
import { checkSubagentDepth, resolveChildDepth, resolveChildMaxSubagentDepth, resolveCurrentMaxSubagentDepth, type SubagentDepthContext } from "../../src/shared/types.ts";
import { evaluateCompletionMutationGuard, validateImplementationToolContract } from "../../src/runs/shared/completion-guard.ts";
import { planCompletionEvidence } from "../../src/runs/shared/completion-evidence.ts";

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

it("revival intersects the current operator limit with the retained limit", () => {
	const source = readFileSync(new URL("../../src/runs/foreground/subagent-executor.ts", import.meta.url), "utf8");
	// Pin the recovery call-site wiring as well as the shared depth helper behavior.
	assert.match(source, /maxSubagentDepth:\s*resolveChildMaxSubagentDepth\(resolveCurrentMaxSubagentDepth\(input\.deps\.config\.maxSubagentDepth, input\.deps\.childRuntime\), recoveryDescriptor\?\.maxSubagentDepth\)/);
	const savedEnv = process.env.PI_SUBAGENT_MAX_DEPTH;
	try {
		delete process.env.PI_SUBAGENT_MAX_DEPTH;
		const cases: Array<{ config: number; retained?: number; runtime?: SubagentDepthContext; expected: number }> = [
			{ config: 1, retained: 2, expected: 1 },
			{ config: 3, retained: 1, expected: 1 },
			{ config: 1, retained: 1, expected: 1 },
			{ config: 1, expected: 1 },
			{ config: 0, retained: 2, expected: 0 },
			{ config: 3, retained: 0, expected: 0 },
			{ config: 5, retained: 4, runtime: { depth: 1, maxDepth: 2 }, expected: 2 },
		];
		for (const scenario of cases) {
			const limit = resolveChildMaxSubagentDepth(resolveCurrentMaxSubagentDepth(scenario.config, scenario.runtime), scenario.retained);
			assert.equal(limit, scenario.expected, JSON.stringify(scenario));
			const child = resolveChildDepth(limit, scenario.runtime);
			assert.equal(checkSubagentDepth(scenario.config, child).blocked, true, JSON.stringify(scenario));
		}
		process.env.PI_SUBAGENT_MAX_DEPTH = "1";
		assert.equal(resolveChildMaxSubagentDepth(resolveCurrentMaxSubagentDepth(5), 4), 1);
	} finally {
		if (savedEnv === undefined) delete process.env.PI_SUBAGENT_MAX_DEPTH;
		else process.env.PI_SUBAGENT_MAX_DEPTH = savedEnv;
	}
});

it("evidence auditing never requires edits for quoted implementation claims", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-auditor-completion-"));
	try {
		const auditor = discoverAgentsAll(cwd).builtin.find(agent => agent.name === "evidence-auditor");
		assert.ok(auditor);
		assert.equal(auditor.completionGuard, false);
		const plan = resolvePiLaunchToolPlan({
			cwd, agentName: auditor.name, tools: auditor.tools, excludeTools: auditor.excludeTools,
			subagentOnlyExtensions: [join(cwd, "configured-search-provider.ts")],
		});
		assert.equal(plan.explicitToolAllowlist, false);
		assert.equal(plan.disableAmbientExtensions, false);
		const task = "Audit the evidence for the claim that upgrading the library will fix the bug.";
		assert.equal(validateImplementationToolContract({
			agent: auditor.name, task, completionGuard: auditor.completionGuard,
			configuredExtensions: plan.configuredExtensions, requestedTools: plan.requestedBuiltinTools,
		}), undefined);
		for (const agentContractEnabled of [false, true]) {
			const enabled = agentContractEnabled ? auditor.completionGuard === true : auditor.completionGuard !== false;
			const guard = enabled ? evaluateCompletionMutationGuard({ agent: auditor.name, task, messages: [] }) : undefined;
			// With no guard there is no LLM arbitration request or rescue dependency.
			const evidence = planCompletionEvidence({
				...(guard ? { guard } : {}), completionGuardEnabled: enabled,
				mutationCapable: true, implementationMutationExpected: true,
				mutationAttemptObserved: false, agentContractEnabled,
			});
			assert.equal(evidence.guardTriggered, false);
			assert.equal(evidence.mutationExpected, false);
			assert.equal(evidence.legacyFailureError, undefined);
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
