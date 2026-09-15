import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readContract, writeJson, type Run } from "./store.ts";
import type { ChildSessionEvent } from "./runs/shared/child-session.ts";

export interface RunProgress {
	activity: string; text: string; tools: number; currentTool?: string; toolInput?: string; toolOutput?: string;
	tokens?: number; cost?: number; updatedAt: string;
}
export function emptyProgress(): RunProgress {
	return { activity: "启动中", text: "", tools: 0, updatedAt: new Date().toISOString() };
}
export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(p => p?.type === "text" ? p.text : p?.type === "toolCall" ? `[${p.name}] ${JSON.stringify(p.arguments)}` : "").filter(Boolean).join("\n");
}
export function applyProgress(p: RunProgress, e: ChildSessionEvent): boolean {
	const message = e.message as { role?: string; content?: unknown; usage?: { totalTokens?: number; cost?: { total?: number } } } | undefined;
	if (e.type === "message_start" && message?.role === "assistant") { p.activity = "生成中"; p.text = ""; }
	else if (e.type === "message_update") {
		const update = e.assistantMessageEvent as { type?: string; delta?: string } | undefined;
		if (update?.type === "text_delta") { p.text = (p.text + (update.delta ?? "")).slice(-4000); p.activity = "输出中"; }
		else if (update?.type === "thinking_delta") p.activity = "思考中";
		else return false;
	} else if (e.type === "message_end" && message?.role === "assistant") {
		p.text = contentText(message.content).slice(-4000);
		if (message.usage) {
			p.tokens = (p.tokens ?? 0) + (message.usage.totalTokens ?? 0);
			p.cost = (p.cost ?? 0) + (message.usage.cost?.total ?? 0);
		}
	} else if (e.type === "tool_execution_start") {
		p.tools++; p.currentTool = String(e.toolName); p.activity = `执行 ${p.currentTool}`;
		p.toolInput = JSON.stringify(e.args ?? {}).slice(0, 2000); p.toolOutput = "";
	} else if (e.type === "tool_execution_update" || e.type === "tool_execution_end") {
		const result = (e.result ?? e.partialResult) as { content?: unknown } | undefined;
		p.toolOutput = contentText(result?.content).slice(-4000);
		if (e.type === "tool_execution_end") { p.currentTool = undefined; p.activity = e.isError ? "工具失败" : "等待模型"; }
	} else return false;
	p.updatedAt = new Date().toISOString();
	return true;
}
export function progressWriter(run: Run) {
	const progress = emptyProgress();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let failedCode: string | undefined;
	const path = join(run.dir, "progress.json");
	const flush = () => {
		if (timer) clearTimeout(timer); timer = undefined;
		// A display snapshot is optional; Windows may temporarily deny replacing a file being read.
		// Keep the prior snapshot and try the next normal update, never fail or replay the task.
		try {
			writeJson(path, progress);
			if (failedCode) console.error(JSON.stringify({ event: "progress_snapshot_recovered", runId: run.id, path }));
			failedCode = undefined;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? "unknown";
			if (failedCode !== code) console.error(JSON.stringify({ event: "progress_snapshot_failed", runId: run.id, path, code, error: String(error), nonfatal: true }));
			failedCode = code;
		}
	};
	flush();
	return {
		update(e: ChildSessionEvent) { if (applyProgress(progress, e) && !timer) timer = setTimeout(flush, 150); },
		finish(status: string) { progress.activity = status; progress.currentTool = undefined; progress.updatedAt = new Date().toISOString(); flush(); },
	};
}
export function readProgress(run: Run): RunProgress | undefined {
	const path = join(run.dir, "progress.json");
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}
export interface RunView {
	run: Run; task: string; model: string; thinking: string; depth: string; context: string; cwd: string;
	requirements?: string; progress?: RunProgress;
}
export function createViewReader(): (run: Run) => RunView {
	const summaries = new Map<string, Omit<RunView, "run" | "progress">>();
	return (run) => {
		let summary = summaries.get(run.dir);
		if (!summary) {
			const c = readContract(run);
			summary = { task: c.task, model: `${c.model.provider}/${c.model.id}`, thinking: c.model.thinking, depth: `${c.depth.depth}/${c.depth.maxDepth}`, context: c.context, cwd: c.cwd, requirements: c.requirements?.path };
			summaries.set(run.dir, summary);
		}
		return { run, ...summary, progress: readProgress(run) };
	};
}
