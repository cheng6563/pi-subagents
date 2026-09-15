import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve, extname } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { splitKnownThinkingSuffix, type ThinkingLevel } from "./shared/model-info.ts";
import { resolveSharedModelReference } from "./shared/shared-models.ts";

export interface Depth { depth: number; maxDepth: number }
export interface Requirements { path: string; text: string; sha256: string }
export interface ModelSelection { provider: string; id: string; thinking: ThinkingLevel }
export interface Contract {
	version: 1;
	task: string;
	cwd: string;
	requirements?: Requirements;
	model: ModelSelection;
	context: "fresh" | "fork";
	contextMessages?: AgentMessage[];
	depth: Depth;
	timeoutMs: number;
}

export function readRequirements(file: string, cwd: string): Requirements {
	const path = resolve(cwd, file);
	try {
		if (extname(path).toLowerCase() !== ".md") throw new Error("expected a Markdown .md file");
		if (!statSync(path).isFile()) throw new Error("not a regular file");
		const bytes = readFileSync(path);
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		return { path, text, sha256: createHash("sha256").update(bytes).digest("hex") };
	} catch (error) {
		throw new Error(`Cannot load requirementsFile '${path}': ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function childDepth(parent: Depth | undefined, requested?: number): Depth {
	if (requested !== undefined && (!Number.isSafeInteger(requested) || requested < 1)) throw new Error("maxDepth must be an integer >= 1");
	if (parent && requested !== undefined && requested > parent.maxDepth) throw new Error(`Cannot increase inherited maxDepth ${parent.maxDepth}`);
	const depth = (parent?.depth ?? 0) + 1;
	const maxDepth = requested ?? parent?.maxDepth ?? 1;
	if (depth > maxDepth) throw new Error(`Subagent depth exhausted: next depth ${depth}, maxDepth ${maxDepth}`);
	return { depth, maxDepth };
}

export function selectModel(
	reference: string | undefined,
	parent: { provider: string; id: string } | undefined,
	thinking: ThinkingLevel,
	available: readonly { provider: string; id: string }[],
): ModelSelection {
	if (!reference && !parent) throw new Error("Parent model is unavailable; cannot inherit a model");
	const expanded = reference ? resolveSharedModelReference(reference) : `${parent!.provider}/${parent!.id}`;
	const { baseModel, thinkingSuffix } = splitKnownThinkingSuffix(expanded);
	const model = available.find((entry) => `${entry.provider}/${entry.id}` === baseModel);
	if (!model) throw new Error(`Selected model '${baseModel}' is unavailable (model or credentials missing); no fallback is allowed`);
	return { provider: model.provider, id: model.id, thinking: (thinkingSuffix.slice(1) || thinking) as ThinkingLevel };
}

/** A fork taken during a tool call must not inherit unmatched tool protocol messages. */
export function forkMessages(messages: readonly AgentMessage[]): AgentMessage[] {
	const calls = new Set(messages.flatMap((m) => m.role === "assistant" ? m.content.filter((p) => p.type === "toolCall").map((p) => p.id) : []));
	const results = new Set(messages.flatMap((m) => m.role === "toolResult" ? [m.toolCallId] : []));
	return structuredClone(messages.flatMap((message): AgentMessage[] => {
		if (message.role === "toolResult") return calls.has(message.toolCallId) ? [message] : [];
		if (message.role !== "assistant") return [message];
		const content = message.content.filter((p) => p.type !== "toolCall" || results.has(p.id));
		return content.length ? [{ ...message, content }] : [];
	}));
}

export function requirementsPrompt(contract: Contract): string {
	return [
		"You are a general child executor. Follow the supplied task and applicable environment instructions. No role or acceptance policy is implied by this executor.",
		`Subagent tool depth: ${contract.depth.depth}/${contract.depth.maxDepth}. ${contract.depth.depth < contract.depth.maxDepth ? "The subagent tool inherits this ceiling and cannot increase it." : "The subagent tool is disabled in this session."} Report blockers and actual results to the parent.`,
		contract.requirements ? `Requirements loaded from ${JSON.stringify(contract.requirements.path)} (SHA-256 ${contract.requirements.sha256}):\n\n${contract.requirements.text}` : "",
	].filter(Boolean).join("\n\n");
}

/** Resume consumes the saved launch snapshot, not mutable source files or model aliases. */
export function validateContract(value: unknown): Contract {
	const c = value as Contract;
	if (!c || c.version !== 1 || typeof c.task !== "string" || !c.task.trim() || typeof c.cwd !== "string"
		|| !c.model || typeof c.model.provider !== "string" || typeof c.model.id !== "string"
		|| !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(c.model.thinking)
		|| !c.depth || !Number.isSafeInteger(c.depth.depth) || c.depth.depth < 1
		|| !Number.isSafeInteger(c.depth.maxDepth) || c.depth.maxDepth < c.depth.depth
		|| !["fresh", "fork"].includes(c.context)
		|| !Number.isSafeInteger(c.timeoutMs) || c.timeoutMs < 1
		|| (c.contextMessages !== undefined && !Array.isArray(c.contextMessages))
		|| (c.requirements !== undefined && (typeof c.requirements.path !== "string" || typeof c.requirements.text !== "string" || typeof c.requirements.sha256 !== "string"))) {
		throw new Error("Invalid saved generic subagent contract; old role-based runs cannot be resumed by this executor");
	}
	return c;
}
