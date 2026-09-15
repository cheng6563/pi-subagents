import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { parameters, validateParams, type Params } from "./parameters.ts";
export { parameters } from "./parameters.ts";
import { buildSessionContext, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { childDepth, readRequirements, selectModel, forkMessages, type Depth, type Contract } from "./contract.ts";
import { RunController, type Notice } from "./controller.ts";
import { storeRoot, type Run } from "./store.ts";
import { getAgentDir } from "./shared/utils.ts";
import { readProgress } from "./progress.ts";
import { createRunResultRenderer, registerRunUI, renderRunCall } from "./ui.ts";

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
	if (depth && depth.depth >= depth.maxDepth) return;
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
	const ui = binding ? undefined : registerRunUI(pi, getController);
	pi.registerTool({
		name: "subagent", label: "subagents",
		description: "Run one generic Pi child with task and optional options; no named roles or inferred business/review criteria. Defaults: exact parent model, fresh context, maxDepth 1. Descendants inherit the absolute depth ceiling and cannot increase it; at the ceiling only the subagent tool is absent. Normal environment tools, extensions and skills still load. Each launch is independent; coordinate shared-file writes across concurrent runs. Resume preserves the original loaded Markdown snapshot, model, depth, cwd and context, and returns a new ID; do not pass task/options to management actions. Inspect status, events.jsonl, saved session and prior side effects before resuming a failure; never automatically replay work or change model. Output is truncated at 24,000 characters; read outputPath for the full result. A child with this tool can report to its parent using action:report.",
		parameters,
		async execute(_callId, input: Params, signal, onUpdate, ctx) {
			const params = validateParams(input);
			const options = params.options ?? {};
			if (signal?.aborted) throw new Error("subagents call was cancelled before launch");
			const defaults = loadDefaults();
			const asynchronous = params.async ?? defaults.asyncByDefault;
			const c = getController(ctx);
			ui?.attach(ctx);
			const launch = async (start: () => Promise<Run>) => {
				const release = ui?.beginLaunch(ctx);
				try { return await start(); } finally { release?.(); }
			};
			const waitFor = async (id: string, waitSignal?: AbortSignal) => {
				let last = "";
				const update = () => {
					try {
						const run = c.status(id);
						const progress = readProgress(run);
						const key = `${run.status}:${progress?.updatedAt}:${Math.floor(Date.now() / 1000)}`;
						if (key !== last) { last = key; onUpdate?.({ content: [{ type: "text", text: `subagents ${id} · ${progress?.activity ?? run.status}` }], details: { run, progress } }); }
					} catch (error) { console.error(JSON.stringify({ event: "subagent_progress_read_failed", runId: id, error: String(error) })); }
				};
				// Interactive progress belongs to the fixed dock, not the scrolling transcript.
				const timer = onUpdate && !ctx.hasUI ? setInterval(update, 250) : undefined;
				try { if (onUpdate) update(); await c.wait(id, waitSignal); return response(c.result(id)); }
				finally { if (timer) clearInterval(timer); }
			};
			if (params.action) {
				for (const key of ["task", "options"] as const) if (params[key] !== undefined) throw new Error(`${key} cannot override a management/resume operation`);
				if (params.action === "report") {
					if (!binding || !params.message?.trim()) throw new Error("report requires a child runtime and message");
					binding.report(params.message); return response({ delivered: true });
				}
				if (params.action === "list") return response(c.list());
				if (!params.id) throw new Error("id is required");
				switch (params.action) {
					case "status": return response(c.status(params.id));
					case "result": return response(c.result(params.id));
					case "wait": return waitFor(params.id, signal);
					case "cancel": return response(await c.cancel(params.id));
					case "interrupt": return response(await c.cancel(params.id, true));
					case "steer": if (!params.message?.trim()) throw new Error("message is required"); c.steer(params.id, params.message); return response({ queued: true, id: params.id });
					case "resume": {
						const run = await launch(() => c.resume(params.id!, params.message, depth, signal, asynchronous));
						if (!asynchronous) return waitFor(run.id);
						return response(run);
					}
				}
			}
			if (!params.task?.trim()) throw new Error("task is required");
			if (params.id || params.message) throw new Error("id/message require a management action");
			const nextDepth = childDepth(depth, options.maxDepth);
			const cwd = resolve(ctx.cwd, options.cwd ?? ".");
			if (!statSync(cwd).isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
			const requirements = options.requirementsFile ? readRequirements(options.requirementsFile, ctx.cwd) : undefined;
			const model = selectModel(options.model, ctx.model, pi.getThinkingLevel(), await ctx.modelRegistry.getAvailable());
			const context = options.context ?? "fresh";
			const contract: Contract = { version: 1, task: params.task, cwd, model, context, depth: nextDepth, timeoutMs: options.timeoutMs ?? defaults.timeoutMs,
				...(requirements ? { requirements } : {}),
				...(context === "fork" ? { contextMessages: forkMessages(buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages) } : {}),
			};
			const run = await launch(() => c.start(contract, { signal, notifyOnComplete: asynchronous }));
			if (!asynchronous) return waitFor(run.id);
			return response(run);
		},
		renderCall: renderRunCall,
		renderResult: createRunResultRenderer(),
	});
	pi.on("session_shutdown", async () => { ui?.dispose(); await controller?.shutdown(); controller = undefined; currentSessionId = undefined; });
}

export default function subagent(pi: ExtensionAPI): void {
	// The worker installs a closure-bound executor inline. Ambient discovery must not create an unbounded root executor.
	if (process.env.PI_SUBAGENT_CHILD || process.env.PI_GENERIC_SUBAGENT) return;
	registerExecutor(pi);
}
