import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { buildSessionContext, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { childDepth, readRequirements, selectModel, forkMessages, type Depth, type Contract } from "./contract.ts";
import { RunController, type Notice } from "./controller.ts";
import { storeRoot } from "./store.ts";
import { getAgentDir } from "./shared/utils.ts";
import { toolCommandBlockReason, commandBlockReason } from "./guard.ts";

export const parameters = Type.Object({
	action: Type.Optional(StringEnum(["status", "list", "result", "wait", "cancel", "interrupt", "resume", "steer", "report"] as const)),
	task: Type.Optional(Type.String({ minLength: 1, description: "Task for the generic executor. Omit action when starting a new run." })),
	requirementsFile: Type.Optional(Type.String({ minLength: 1, description: "UTF-8 .md file, resolved relative to the caller cwd and read before launch. Resume uses the saved contents." })),
	model: Type.Optional(Type.String({ minLength: 1, description: "Default: exact parent model. Use shared:lowCost or provider/model[:thinking]. Missing/unavailable models fail without fallback." })),
	maxDepth: Type.Optional(Type.Integer({ minimum: 1, description: "Absolute tree depth ceiling. Root default 1; children inherit the ceiling and may only reduce it." })),
	context: Type.Optional(StringEnum(["fresh", "fork"] as const, { description: "Default fresh: no parent history/system prompt. fork explicitly copies parent conversation, never the parent system prompt. Normal environment resources still load." })),
	cwd: Type.Optional(Type.String({ minLength: 1 })),
	async: Type.Optional(Type.Boolean({ description: "Default true. Completion notifies this parent; false waits in this call." })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
	id: Type.Optional(Type.String({ description: "Exact run UUID for status/control/recovery." })),
	message: Type.Optional(Type.String({ minLength: 1, description: "Resume/steer message or a child report to its parent." })),
}, { additionalProperties: false });

interface Params {
	action?: "status" | "list" | "result" | "wait" | "cancel" | "interrupt" | "resume" | "steer" | "report";
	task?: string; requirementsFile?: string; model?: string; maxDepth?: number; context?: "fresh" | "fork";
	cwd?: string; async?: boolean; timeoutMs?: number; id?: string; message?: string;
}
interface Defaults { asyncByDefault: boolean; timeoutMs: number }
export function loadDefaults(): Defaults {
	const file = join(getAgentDir(), "extensions", "subagent", "config.json");
	if (!existsSync(file)) return { asyncByDefault: true, timeoutMs: 1_800_000 };
	const c = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	const unknown = Object.keys(c).filter((key) => !["asyncByDefault", "timeoutMs"].includes(key));
	if (unknown.length) throw new Error(`Unsupported subagent configuration in ${file}: ${unknown.join(", ")}. See the independent executor README`);
	if (c.asyncByDefault !== undefined && typeof c.asyncByDefault !== "boolean") throw new Error("asyncByDefault must be boolean");
	if (c.timeoutMs !== undefined && (!Number.isSafeInteger(c.timeoutMs) || (c.timeoutMs as number) < 1)) throw new Error("timeoutMs must be an integer >= 1");
	return { asyncByDefault: c.asyncByDefault as boolean ?? true, timeoutMs: c.timeoutMs as number ?? 1_800_000 };
}
function response(value: unknown) {
	const text = JSON.stringify(value, null, 2);
	return { content: [{ type: "text" as const, text: text.length > 24_000 ? `${text.slice(0, 24_000)}\n[Truncated; read the run's outputPath/events.jsonl for full content.]` : text }], details: value };
}
export interface ChildBinding {
	depth: Depth;
	root: string;
	report(message: string): void;
	onController(controller: RunController): void;
}

export function registerExecutor(pi: ExtensionAPI, binding?: ChildBinding): void {
	// Child authority is closure-bound. It is never recovered from a model-controlled environment variable.
	const depth = binding ? Object.freeze({ ...binding.depth }) : undefined;
	let controller: RunController | undefined;
	let currentSessionId: string | undefined;
	function getController(ctx: ExtensionContext): RunController {
		const id = ctx.sessionManager.getSessionId();
		if (controller && currentSessionId !== id) throw new Error("Session changed before executor shutdown");
		if (!controller) {
			currentSessionId = id;
			controller = new RunController(binding?.root ?? storeRoot(id), (notice: Notice) => {
				try {
					pi.sendMessage({ customType: "subagent-notice", content: JSON.stringify(notice), display: true, details: notice }, { triggerTurn: !binding, deliverAs: "followUp" });
				} catch (error) { console.error(JSON.stringify({ event: "subagent_notification_failed", runId: notice.runId, error: String(error) })); }
			});
			binding?.onController(controller);
		}
		return controller;
	}
	pi.registerTool({
		name: "subagent", label: "Subagent",
		description: "Run one generic Pi child with task and optional requirementsFile; no named roles or inferred review/acceptance policy. Parent model and fresh context are defaults. maxDepth defaults to 1 and descendants cannot enlarge it. Normal tools/extensions load. Async completion notifies the parent. Use exact run IDs for status, result, wait, cancel, interrupt, resume and steer; resume preserves loaded requirements/model/depth and returns a new ID. Inspect failed-run evidence before resuming; no automatic replay or model fallback. Output text is truncated at 24,000 characters; full result is at outputPath. A child can report to its parent with action:report.",
		parameters,
		async execute(_callId, params: Params, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Subagent call was cancelled before launch");
			const defaults = loadDefaults();
			const c = getController(ctx);
			if (params.action) {
				for (const key of ["task", "requirementsFile", "model", "maxDepth", "context", "cwd", "timeoutMs"] as const) if (params[key] !== undefined) throw new Error(`${key} cannot override a management/resume operation`);
				if (params.action === "report") {
					if (!binding || !params.message?.trim()) throw new Error("report requires a child runtime and message");
					binding.report(params.message); return response({ delivered: true });
				}
				if (params.action === "list") return response(c.list());
				if (!params.id) throw new Error("id is required");
				switch (params.action) {
					case "status": return response(c.status(params.id));
					case "result": return response(c.result(params.id));
					case "wait": await c.wait(params.id, signal); return response(c.result(params.id));
					case "cancel": return response(await c.cancel(params.id));
					case "interrupt": return response(await c.cancel(params.id, true));
					case "steer": if (!params.message?.trim()) throw new Error("message is required"); c.steer(params.id, params.message); return response({ queued: true, id: params.id });
					case "resume": {
						const run = await c.resume(params.id, params.message, depth, signal);
						if ((params.async ?? defaults.asyncByDefault) === false) { await c.wait(run.id); return response(c.result(run.id)); }
						return response(run);
					}
				}
			}
			if (!params.task?.trim()) throw new Error("task is required");
			if (params.id || params.message) throw new Error("id/message require a management action");
			const nextDepth = childDepth(depth, params.maxDepth);
			const cwd = resolve(ctx.cwd, params.cwd ?? ".");
			if (!statSync(cwd).isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
			const requirements = params.requirementsFile ? readRequirements(params.requirementsFile, ctx.cwd) : undefined;
			const model = selectModel(params.model, ctx.model, pi.getThinkingLevel(), await ctx.modelRegistry.getAvailable());
			const context = params.context ?? "fresh";
			const contract: Contract = { version: 1, task: params.task, cwd, model, context, depth: nextDepth, timeoutMs: params.timeoutMs ?? defaults.timeoutMs,
				...(requirements ? { requirements } : {}),
				...(context === "fork" ? { contextMessages: forkMessages(buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages) } : {}),
			};
			const run = await c.start(contract, { signal });
			if ((params.async ?? defaults.asyncByDefault) === false) {
				await c.wait(run.id); return response(c.result(run.id));
			}
			return response(run);
		},
	});
	if (binding) {
		pi.on("tool_call", (event, ctx) => {
			const reason = toolCommandBlockReason(event.toolName, event.input, ctx.cwd);
			if (reason) return { block: true, reason };
		});
		pi.on("user_bash", (event) => {
			const reason = commandBlockReason(event.command, event.cwd);
			if (reason) return { result: { output: reason, exitCode: 1, cancelled: false, truncated: false } };
		});
	}
	pi.on("session_shutdown", async () => { await controller?.shutdown(); controller = undefined; currentSessionId = undefined; });
}

export default function subagent(pi: ExtensionAPI): void {
	// The worker installs a closure-bound executor inline. Ambient discovery must not create an unbounded root executor.
	if (process.env.PI_SUBAGENT_CHILD || process.env.PI_GENERIC_SUBAGENT) return;
	registerExecutor(pi);
}
