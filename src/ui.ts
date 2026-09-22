import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { keyText, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { RunController, Notice } from "./controller.ts";
import { isTerminal, listRuns, type Run } from "./store.ts";
import { contentText, createViewReader, type RunView } from "./progress.ts";
import type { Params } from "./parameters.ts";

type Theme = ExtensionContext["ui"]["theme"];
const labels: Record<string, string> = { queued: "启动中", running: "运行中", completed: "已完成", failed: "失败", paused: "已暂停", cancelled: "已取消" };
const widgetKey = "subagent-fleet";
function state(status: string, theme: Theme): string {
	return theme.fg(status === "failed" ? "error" : status === "completed" ? "success" : "warning", labels[status] ?? status);
}
function elapsed(run: Run): string {
	const ms = Math.max(0, (isTerminal(run.status) ? Date.parse(run.updatedAt) : Date.now()) - Date.parse(run.createdAt));
	return ms < 60000 ? `${Math.floor(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${Math.floor(ms / 1000) % 60}s`;
}
function stats(v: RunView): string {
	return `${elapsed(v.run)} · ${compactUsage(v)}`;
}
function singleLine(text: string): string { return stripVTControlCharacters(text).replace(/[\r\n\t]+/g, " "); }
function brief(text: string, width: number): string { return truncateToWidth(singleLine(text).split(/(?<=[。！？])/u)[0]?.trim() ?? "", width); }
function activity(v: RunView): string {
	if (isTerminal(v.run.status)) return labels[v.run.status]!;
	const current = v.progress?.activity;
	return current && !labels[current] ? current : labels[v.run.status]!;
}
function dynamic(render: (width: number) => string[]): Component { return { render, invalidate() {} }; }

export const LIVE_PANEL_MAX_ROWS = 8;
export function tailPreview(text: string, width: number, count = 4): { lines: string[]; hidden: number } {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	return {
		lines: lines.slice(-count).map(line => truncateToWidth(stripVTControlCharacters(line).replace(/\t/g, "    ").replace(/\r/g, ""), width)),
		hidden: Math.max(0, lines.length - count),
	};
}

const controlLabels = { steer: "补充指令", resume: "恢复", interrupt: "暂停", cancel: "取消" } as const;
const actionLabels: Record<NonNullable<Params["action"]>, string> = {
	...controlLabels,
	status: "查看状态", list: "列出任务", result: "读取结果", wait: "等待完成", report: "汇报",
};
type ControlAction = keyof typeof controlLabels;
function isControlAction(action: Params["action"]): action is ControlAction {
	return action !== undefined && Object.hasOwn(controlLabels, action);
}
export function renderRunCall(args: Params, theme: Theme): Component {
	const action = args.action ? actionLabels[args.action] ?? args.action : undefined;
	return dynamic(width => [truncateToWidth(`${theme.fg("toolTitle", theme.bold("subagents"))} ${action ?? (args.async === false ? "同步" : "启动")} ${args.id?.slice(0, 8) ?? ""}${args.task ? ` · ${brief(args.task, 72)}` : ""}`, width)]);
}
function controlLines(action: ControlAction, args: Params, run: Run, task: string, expanded: boolean, theme: Theme, width: number): string[] {
	let heading: string;
	if (action === "steer") heading = "补充指令已入队（等待子代理处理）";
	else if (action === "resume") heading = `已创建恢复运行 · ${labels[run.status] ?? run.status}`;
	else {
		const expected = action === "interrupt" ? "paused" : "cancelled";
		heading = run.status === expected
			? `${labels[run.status]}（${action === "interrupt" ? "可恢复" : "不可恢复"}）`
			: `${controlLabels[action]}未执行 · 当前${labels[run.status] ?? run.status}`;
	}
	const ids = action === "resume" ? `${(run.resumedFrom ?? args.id ?? "").slice(0, 8)} → ${run.id.slice(0, 8)}` : run.id.slice(0, 8);
	const lines = [truncateToWidth(`${theme.fg("accent", heading)} · ${ids}`, width)];
	let clipped = false;
	const field = (label: string, value: string) => {
		if (expanded) lines.push(...new Text(`${label}：${stripVTControlCharacters(value)}`, 0, 0).render(width));
		else {
			const text = `${label}：${singleLine(value)}`;
			clipped ||= /[\r\n]/.test(value) || visibleWidth(text) > width;
			lines.push(truncateToWidth(text, width));
		}
	};
	field("任务", task);
	if (args.message) field("指令", args.message);
	if (run.error && run.status === "failed") field("错误", run.error);
	if (expanded) {
		if (action === "resume" && run.resumedFrom) field("原 ID", run.resumedFrom);
		field("ID", run.id);
	} else if (clipped) {
		const key = keyText("app.tools.expand");
		lines.push(truncateToWidth(theme.fg("dim", key ? `${key} 展开完整内容` : "展开查看完整内容"), width));
	}
	return lines.map(line => truncateToWidth(line, width));
}
export const COMPLETION_ENTRY = "subagents-completion";
export interface CompletionCard { view: RunView; output: string }
function finalLines(v: RunView, output: string, expanded: boolean, theme: Theme, width: number): string[] {
	const run = v.run;
	const lines = [`${state(run.status, theme)} ${theme.fg("accent", run.id.slice(0, 8))} · ${v.model}`, theme.fg("dim", stats(v))];
	if (expanded) lines.push(...new Text(`任务：${v.task}\n${v.thinking} · 深度 ${v.depth} · ${v.context}`, 0, 0).render(width));
	if (run.error) {
		const error = new Text(theme.fg("error", run.error), 0, 0).render(width);
		lines.push(...(expanded ? error : error.slice(0, 2)));
	}
	if (output) {
		if (run.status !== "completed") lines.push(theme.fg("warning", "未完成输出："));
		const preview = tailPreview(output, width);
		if (!expanded && preview.hidden > 0) {
			const key = keyText("app.tools.expand");
			lines.push(theme.fg("dim", `… 前 ${preview.hidden} 行已折叠 · ${key ? `${key} 展开` : "/subagents 查看"}`));
		}
		lines.push(...(expanded ? new Text(output, 0, 0).render(width) : preview.lines));
	}
	if (expanded) lines.push(...new Text(theme.fg("dim", `ID ${run.id}\n产物 ${run.outputPath}\n日志 ${join(run.dir, "runner.log")}`), 0, 0).render(width));
	return lines.map(line => truncateToWidth(line, width));
}
export function renderCompletionCard(data: CompletionCard, expanded: boolean, theme: Theme): Component {
	return dynamic(width => [
		truncateToWidth(theme.fg("toolTitle", theme.bold(`subagents · ${singleLine(data.view.task)}`)), width),
		truncateToWidth(theme.fg("dim", `深度 ${data.view.depth}${data.view.parentId ? ` · 父 ${data.view.parentId.slice(0, 8)}` : ""}`), width),
		...finalLines(data.view, data.output, expanded, theme, width),
	]);
}
export function createRunResultRenderer() {
	const readView = createViewReader();
	const completed = new Map<string, { view: RunView; output: string }>();
	return (result: { details?: unknown; content: unknown }, options: { expanded: boolean; isPartial?: boolean }, theme: Theme, context?: { args?: Params; isError?: boolean }): Component => dynamic(width => {
		const data = result.details as { run?: Run; output?: string; id?: string; dir?: string; uiResultAtTail?: boolean } | Run[] | undefined;
		const runs = Array.isArray(data) ? data : data && ("run" in data && data.run ? [data.run] : "dir" in data && data.dir ? [data as Run] : []);
		if (!runs?.length) return options.isPartial ? [truncateToWidth("运行中", width)] : new Text(contentText(result.content), 0, 0).render(width);
		const lines: string[] = [];
		for (const snapshot of runs.slice(0, options.expanded ? runs.length : 5)) {
			try {
				const args = context?.args;
				if (!options.isPartial && !context?.isError && args && isControlAction(args.action)) {
					const view = readView(snapshot, false);
					lines.push(...controlLines(args.action, args, snapshot, view.task, options.expanded, theme, width));
					continue;
				}
				const receipt = !Array.isArray(data) && data?.uiResultAtTail;
				if (receipt || options.isPartial || !isTerminal(snapshot.status)) {
					const view = readView(snapshot, false);
					// The receipt never changes when the worker finishes; results are appended separately.
					lines.push(`已提交 ${snapshot.id.slice(0, 8)} · ${view.model}`, theme.fg("dim", singleLine(view.task)));
					continue;
				}
				let saved = completed.get(snapshot.dir);
				if (!saved) {
					const view = readView(snapshot);
					const resultOutput = !Array.isArray(data) && data && "output" in data ? data.output : undefined;
					const output = resultOutput || (existsSync(snapshot.outputPath) ? readFileSync(snapshot.outputPath, "utf8") : "") || view.progress?.text || "";
					saved = { view, output };
					completed.set(snapshot.dir, saved);
				}
				if (Array.isArray(data)) lines.push(brief(saved.view.task, width));
				lines.push(...finalLines(saved.view, saved.output, options.expanded, theme, width));
			} catch (error) { lines.push(...new Text(`${snapshot.id} · ${snapshot.status}\n${String(error)}`, 0, 0).render(width)); }
		}
		return lines.map(line => truncateToWidth(line, width));
	});
}
export function renderRunNotice(notice: Notice, expanded: boolean, theme: Theme): Component {
	return dynamic(width => new Text(`${theme.fg("accent", "subagents")} ${notice.runId.slice(0, 8)} · ${state(String(notice.status ?? (notice.error ? "failed" : "报告")), theme)}${notice.message ? `\n${notice.message}` : ""}${notice.error ? `\n${notice.error}` : ""}${expanded && notice.outputPath ? `\n产物 ${notice.outputPath}` : ""}`, 0, 0).render(width));
}
export function lastParagraph(text: string): string {
	return singleLine(text.trim().split(/\r?\n[ \t]*\r?\n/).at(-1) ?? "").trim();
}
export function compactUsage(v: RunView): string {
	const cost = v.progress?.cost;
	return `tools ${v.progress?.tools ?? "—"} · $${cost === undefined ? "—" : Number(cost.toPrecision(2)).toString()}`;
}
export function renderRoster(views: RunView[], theme: Theme, width: number, pending = 0): string[] {
	const active = views.filter(v => !isTerminal(v.run.status));
	if (!active.length && !pending) return [];
	const byId = new Map(views.map(v => [v.run.id, v]));
	const children = new Map<string, RunView[]>();
	const roots: RunView[] = [];
	for (const v of views) {
		if (v.parentId && byId.has(v.parentId)) children.set(v.parentId, [...(children.get(v.parentId) ?? []), v]);
		else roots.push(v);
	}
	const activeRoots = new Set(active.map(v => {
		let root = v;
		while (root.parentId && byId.has(root.parentId)) root = byId.get(root.parentId)!;
		return root.run.id;
	}));
	const nodes: { view: RunView; prefix: string }[] = [];
	const visit = (siblings: RunView[], prefix: string) => siblings.forEach((view, index) => {
		const last = index === siblings.length - 1;
		nodes.push({ view, prefix: `${prefix}${last ? "└─ " : "├─ "}` });
		visit(children.get(view.run.id) ?? [], `${prefix}${last ? "   " : "│  "}`);
	});
	visit(roots.filter(v => activeRoots.has(v.run.id)), "");
	const capacity = LIVE_PANEL_MAX_ROWS - 1;
	const shown = nodes.length > capacity ? capacity - 1 : nodes.length;
	const lines = [theme.fg("dim", `subagents · ${active.length} 运行${pending ? ` · ${pending} 启动中` : ""} · /subagents`)];
	for (const { view: v, prefix } of nodes.slice(0, shown)) {
		const summary = brief(v.task, Math.max(4, Math.min(24, Math.floor(width / 4))));
		const heading = `${theme.fg("dim", prefix)}${state(v.run.status, theme)} · ${summary} · ${theme.fg("dim", compactUsage(v))} · `;
		// Legacy snapshots can contain serialized tool calls in text: never use them as a dock fallback.
		const text = v.progress?.previewText || (v.progress?.currentTool ? `执行工具 ${v.progress.currentTool}` : activity(v));
		lines.push(heading + truncateToWidth(lastParagraph(text), Math.max(0, width - visibleWidth(heading))));
	}
	if (nodes.length > shown) lines.push(theme.fg("dim", `more ${nodes.length - shown} agents...`));
	return lines.map(line => truncateToWidth(line, width));
}

export type FleetAction = "pause" | "cancel" | "resume" | "steer";
export class FleetComponent implements Component {
	private views: RunView[] = [];
	private selectedId?: string;
	private scroll = 0;
	private tab = 0;
	private followTail = true;
	private bodyLength = 0;
	private currentText = "";
	private historyText?: string;
	private closed = false;
	private busy = false;
	private notice = "";
	private pageSize = 10;
	private transcriptCache?: { key: string; text: string; lastAssistant: string };
	private readonly readViews: () => RunView[];
	private readonly theme: Theme;
	private readonly redraw: () => void;
	private readonly close: () => void;
	private readonly height: () => number;
	private readonly action: (action: FleetAction, view: RunView) => Promise<void | boolean>;
	constructor(readViews: () => RunView[], theme: Theme, redraw: () => void, close: () => void, height: () => number, action: (action: FleetAction, view: RunView) => Promise<void | boolean>) {
		this.readViews = readViews; this.theme = theme; this.redraw = redraw; this.close = close; this.height = height; this.action = action;
		this.refresh();
	}
	refresh(): void {
		if (this.closed) return;
		try {
			this.views = this.readViews();
			if (!this.views.some(v => v.run.id === this.selectedId)) {
				this.selectedId = (this.views.find(v => !isTerminal(v.run.status)) ?? this.views[0])?.run.id;
				this.resetPosition();
			}
		} catch (error) { this.notice = `读取失败：${String(error)}`; }
		this.redraw();
	}
	private resetPosition(): void {
		this.scroll = 0; this.followTail = this.tab !== 2; this.transcriptCache = undefined;
		this.currentText = ""; this.historyText = undefined;
	}
	private moveSelection(delta: number): void {
		if (!this.views.length) return;
		const index = this.views.findIndex(v => v.run.id === this.selectedId);
		this.selectedId = this.views[(index + delta + this.views.length) % this.views.length]!.run.id;
		this.notice = ""; this.resetPosition();
	}
	private moveScroll(delta: number): void {
		if (delta < 0 && this.tab !== 2 && this.currentText) this.historyText ??= this.currentText;
		const max = Math.max(0, this.bodyLength - this.pageSize);
		this.scroll = Math.max(0, Math.min(max, this.scroll + delta));
		this.followTail = delta > 0 && this.scroll === max && this.tab !== 2;
		if (this.followTail) this.historyText = undefined;
	}
	// Structural type keeps the extension compatible with hosts before mouse support.
	handleMouse(event: { type: string; wheelDelta?: number }) {
		if (event.type === "wheel" && event.wheelDelta) {
			this.moveScroll(event.wheelDelta < 0 ? -3 : 3);
			this.redraw();
			return { handled: true, render: true };
		}
		return { handled: true };
	}
	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") { this.closed = true; this.close(); return; }
		if (matchesKey(data, "tab") || matchesKey(data, "enter") || /^[123]$/.test(data)) {
			this.tab = /^[123]$/.test(data) ? Number(data) - 1 : (this.tab + 1) % 3;
			this.resetPosition();
		} else if (matchesKey(data, "left") || matchesKey(data, "right")) this.moveSelection(matchesKey(data, "left") ? -1 : 1);
		else if (matchesKey(data, "pageUp")) this.moveScroll(-this.pageSize);
		else if (matchesKey(data, "pageDown")) this.moveScroll(this.pageSize);
		else if (matchesKey(data, "up") || data === "k" || data === "K") this.moveScroll(-1);
		else if (matchesKey(data, "down") || data === "j" || data === "J") this.moveScroll(1);
		else if (matchesKey(data, "home")) {
			this.scroll = 0; this.followTail = false;
			if (this.tab !== 2 && this.currentText) this.historyText ??= this.currentText;
		}
		else if (matchesKey(data, "end")) { this.scroll = Math.max(0, this.bodyLength - this.pageSize); this.followTail = this.tab !== 2; this.historyText = undefined; }
		else if (["p", "D", "c", "s"].includes(data)) {
			const v = this.views.find(v => v.run.id === this.selectedId);
			if (v && !this.busy) {
				this.busy = true; this.notice = "处理中…";
				void this.action(({ p: "pause", D: "cancel", c: "resume", s: "steer" } as const)[data as "p" | "D" | "c" | "s"], v)
					.then(result => { this.notice = result === false ? "已取消操作" : "操作完成"; }, error => { this.notice = `操作失败：${String(error)}`; })
					.finally(() => { this.busy = false; this.refresh(); });
			}
		}
		if (!this.closed) this.redraw();
	}
	private conversation(v: RunView): string {
		const path = v.run.sessionFile;
		if (!path || !existsSync(path)) return this.output(v);
		const stat = statSync(path);
		const key = `${path}:${stat.mtimeMs}:${stat.size}`;
		if (this.transcriptCache?.key !== key) {
			const chunks: string[] = [];
			let lastAssistant = "";
			for (const line of readFileSync(path, "utf8").split("\n")) {
				try {
					const entry = JSON.parse(line);
					if (entry.type !== "message" || !entry.message) continue;
					const message = entry.message;
					const role = ({ user: "用户 / 任务", assistant: "子代理", toolResult: "工具结果" } as Record<string, string>)[message.role] ?? message.role;
					const text = contentText(message.content);
					if (message.role === "assistant") lastAssistant = text;
					if (text) chunks.push(`【${role}${message.toolName ? ` · ${message.toolName}` : ""}】\n${text}`);
				} catch { /* A live JSONL file can end with an incomplete entry. */ }
			}
			this.transcriptCache = { key, text: chunks.join("\n\n"), lastAssistant };
		}
		const live = !isTerminal(v.run.status) ? v.progress?.text : "";
		const pending = live && !this.transcriptCache.lastAssistant.endsWith(live) ? `\n\n【子代理 · 实时输出】\n${live}` : "";
		return (this.transcriptCache.text + pending + this.liveToolOutput(v)).trim() || this.output(v);
	}
	private liveToolOutput(v: RunView): string {
		const tool = !isTerminal(v.run.status) && v.progress?.currentTool;
		return tool ? `\n\n【工具 · ${tool} · 运行中】\n${v.progress?.toolOutput || "等待工具输出…"}` : "";
	}
	private output(v: RunView): string {
		const saved = isTerminal(v.run.status) && existsSync(v.run.outputPath) ? readFileSync(v.run.outputPath, "utf8") : "";
		const text = saved || v.progress?.text || v.progress?.previewText || "";
		return (text + this.liveToolOutput(v)).trim() || (isTerminal(v.run.status) ? "没有输出记录。" : "等待子代理输出…");
	}
	render(width: number): string[] {
		const height = this.height();
		if (width < 36 || height < 16) return new Text("subagents 详情需 36 列、16 行；Esc 关闭。", 0, 0).render(width).slice(0, height);
		const t = this.theme;
		const innerWidth = width - 4;
		const row = (text: string) => {
			const clipped = truncateToWidth(text, innerWidth);
			return `${t.fg("borderAccent", "│")} ${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))} ${t.fg("borderAccent", "│")}`;
		};
		const rule = (left: string, right: string, title = "") => {
			const text = truncateToWidth(title ? `─ ${title} ` : "", width - 2);
			return t.fg("borderAccent", left + text + "─".repeat(Math.max(0, width - 2 - visibleWidth(text))) + right);
		};
		const index = this.views.findIndex(v => v.run.id === this.selectedId);
		const v = this.views[index];
		const listSize = Math.min(height < 24 ? 1 : 3, this.views.length);
		const start = Math.max(0, Math.min(index - Math.floor(listSize / 2), this.views.length - listSize));
		const header = [rule("┌", "┐", "subagents 运行详情 · Esc 关闭"), row(`代理 ${index + 1}/${this.views.length} · ← → 切换代理`)];
		for (const item of this.views.slice(start, start + listSize)) {
			header.push(row(`${item.run.id === this.selectedId ? t.fg("accent", "▶") : " "} ${state(item.run.status, t)} ${item.run.id.slice(0, 8)} · ${brief(item.task, innerWidth)}`));
		}
		header.push(rule("├", "┤"));
		if (v) header.push(row(`${state(v.run.status, t)} · 深度 ${v.depth} · ${v.model} · ${compactUsage(v)}`));
		const tabs = ["会话", "输出", "任务"];
		header.push(row(tabs.map((name, i) => i === this.tab ? t.fg("accent", t.bold(`[${i + 1} ${name}]`)) : `${i + 1} ${name}`).join("   ") + " · Tab 切换"), rule("├", "┤"));
		let text = "当前会话没有子代理运行。";
		if (this.historyText !== undefined) text = this.historyText;
		else if (v) try {
			text = this.tab === 0 ? this.conversation(v) : this.tab === 1 ? this.output(v) : `任务提示\n${v.task}\n\nID ${v.run.id}\n${v.model} · ${v.thinking} · 深度 ${v.depth} · ${v.context}\n目录 ${v.cwd}${v.requirements ? `\n要求 ${v.requirements}` : ""}\n产物 ${v.run.outputPath}${v.run.sessionFile ? `\n会话 ${v.run.sessionFile}` : ""}${v.parentId ? `\n父代理 ${v.parentId}` : ""}`;
			if (v.run.error) text += `\n\n错误：${v.run.error}`;
		} catch (error) { text = `读取失败：${String(error)}`; }
		// Freeze content, not just line numbers: live progress is a rolling 4000-character tail.
		this.currentText = text;
		if (!this.followTail && this.tab !== 2) this.historyText ??= text;
		// Plain text keeps persisted content from injecting terminal controls into the frame.
		const body = new Text(stripVTControlCharacters(text).replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\t/g, "    "), 0, 0).render(innerWidth);
		const help = innerWidth >= 76
			? ["↑↓ / j k 滚动 · PgUp/PgDn 翻页 · Home 开头 · End 最新", "p 暂停 · D 取消 · c 恢复 · s 补充任务"]
			: ["↑↓ 滚动 · PgUp/PgDn 翻页", "Home 开头 · End 最新", "p 暂停 D 取消 c 恢复 s 补充"];
		this.pageSize = Math.max(1, height - header.length - help.length - 3);
		this.bodyLength = body.length;
		const max = Math.max(0, body.length - this.pageSize);
		this.scroll = this.followTail ? max : Math.min(this.scroll, max);
		const content = body.slice(this.scroll, this.scroll + this.pageSize);
		while (content.length < this.pageSize) content.push("");
		const position = `${tabs[this.tab]} ${body.length ? this.scroll + 1 : 0}–${Math.min(body.length, this.scroll + this.pageSize)}/${body.length} · ${this.followTail ? "跟随最新 · 自动更新" : this.tab === 2 ? "任务详情" : "历史快照 · End 接回最新"}`;
		return [...header, ...content.map(row), rule("├", "┤"), row(this.notice || position), ...help.map(line => row(t.fg("dim", line))), rule("└", "┘")];
	}
	invalidate(): void { this.transcriptCache = undefined; }
	dispose(): void { this.closed = true; }
}

export function registerRunUI(pi: ExtensionAPI, getController: (ctx: ExtensionContext) => RunController) {
	const reader = createViewReader();
	let context: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let fleetOpen = false;
	let pending = 0;
	let mounted = false;
	let currentViews: RunView[] = [];
	let readError: string | undefined;
	let redraw: (() => void) | undefined;
	let initialized = false;
	const published = new Set<string>();
	const views = (ctx: ExtensionContext) => {
		const result: RunView[] = [];
		const visit = (runs: Run[], parentId?: string) => { for (const run of runs) { result.push({ ...reader(run), ...(parentId ? { parentId } : {}) }); visit(listRuns(join(run.dir, "children")), run.id); } };
		visit(getController(ctx).list());
		return result;
	};
	const refresh = () => {
		if (!context?.hasUI) return;
		try {
			currentViews = views(context); readError = undefined;
			if (!initialized) {
				// Opening an existing session must not replay every historical completion.
				for (const v of currentViews) if (isTerminal(v.run.status)) published.add(v.run.id);
				initialized = true;
			} else for (const v of currentViews) {
				if (!isTerminal(v.run.status) || published.has(v.run.id)) continue;
				published.add(v.run.id);
				try {
					const output = (existsSync(v.run.outputPath) ? readFileSync(v.run.outputPath, "utf8") : "") || v.progress?.text || "";
					pi.appendEntry<CompletionCard>(COMPLETION_ENTRY, { view: v, output });
				} catch (error) {
					console.error(JSON.stringify({ event: "subagents_completion_display_failed", runId: v.run.id, error: String(error) }));
					readError = `完成结果展示失败：${v.run.id} · ${String(error)}`;
				}
			}
		} catch (error) { readError = String(error); }
		const visible = !fleetOpen && (pending > 0 || readError !== undefined || currentViews.some(v => !isTerminal(v.run.status)));
		if (visible) {
			if (!mounted) {
				mounted = true;
				// Mount once; changing data must not rebuild the widget/layout on every tick.
				context.ui.setWidget(widgetKey, (tui, theme) => {
					let width = tui.terminal.columns;
					let previous = "";
					const frame = (w: number) => {
						if (!readError) return renderRoster(currentViews, theme, w, pending);
						const errorLines = ["subagents · 状态读取失败", ...tailPreview(readError, w).lines];
						return errorLines.slice(0, LIVE_PANEL_MAX_ROWS).map(line => truncateToWidth(line, w));
					};
					redraw = () => { const next = frame(width).join("\n"); if (next !== previous) { previous = next; tui.requestRender(); } };
					return { render(w) { width = w; const lines = frame(w); previous = lines.join("\n"); return lines; }, invalidate() { previous = ""; } };
				}, { placement: "belowEditor" });
			} else redraw?.();
			if (!timer) { timer = setInterval(refresh, 250); timer.unref(); }
		} else {
			if (timer) clearInterval(timer); timer = undefined;
			if (mounted) context.ui.setWidget(widgetKey, undefined);
			mounted = false; redraw = undefined;
		}
	};
	const attach = (ctx: ExtensionContext) => { if (ctx.hasUI) { context = ctx; refresh(); } };
	const beginLaunch = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return () => {};
		context = ctx; pending++; refresh();
		return () => { pending = Math.max(0, pending - 1); refresh(); };
	};
	const open = async (_args: string, ctx: ExtensionContext) => {
		if (!ctx.hasUI) { ctx.ui.notify("/subagents 需要交互界面；非交互模式请使用 subagent list/status/result。", "info"); return; }
		if (fleetOpen) return;
		attach(ctx); fleetOpen = true; refresh();
		let refreshTimer: ReturnType<typeof setInterval> | undefined;
		try {
			// Fullscreen Pi consumes viewport paging keys unless a focused overlay owns them.
			await ctx.ui.custom<void>((tui, theme, _keys, done) => {
				const component = new FleetComponent(() => { refresh(); return currentViews; }, theme, () => tui.requestRender(), () => done(), () => Math.floor(tui.terminal.rows * 0.9), async (action, view) => {
					const c = getController(ctx);
					if (resolve(view.run.dir) !== resolve(c.root, view.run.id)) throw new Error("后代运行仅供查看；控制操作须交给它所属的父代理。");
					if (action === "steer") { const message = await ctx.ui.input("补充 subagents 任务", view.run.id); if (!message?.trim()) return false; c.steer(view.run.id, message); return; }
					if (!await ctx.ui.confirm({ pause: "暂停 subagents", cancel: "取消 subagents（不可恢复）", resume: "使用保存的会话恢复 subagents" }[action], `${view.run.id}\n${view.task}`)) return false;
					if (action === "resume") {
						const release = beginLaunch(ctx);
						try { await c.resume(view.run.id, undefined); } finally { release(); }
					} else await c.cancel(view.run.id, action === "pause");
				});
				refreshTimer = setInterval(() => component.refresh(), 250);
				return component;
			}, { overlay: true, overlayOptions: { width: "100%", maxHeight: "90%", anchor: "center" } });
		} finally { if (refreshTimer) clearInterval(refreshTimer); fleetOpen = false; refresh(); }
	};
	pi.registerCommand("subagents", { description: "打开 subagents 运行详情", handler: open });
	pi.registerMessageRenderer<Notice>("subagent-notice", (message, options, theme) => message.details ? renderRunNotice(message.details, options.expanded, theme) : new Text(contentText(message.content), 0, 0));
	pi.registerEntryRenderer<CompletionCard>(COMPLETION_ENTRY, (entry, options, theme) => entry.data ? renderCompletionCard(entry.data, options.expanded, theme) : undefined);
	pi.on("session_start", (_event, ctx) => attach(ctx));
	return { attach, beginLaunch, refresh, dispose() {
		if (timer) clearInterval(timer); timer = undefined;
		if (mounted) context?.ui.setWidget(widgetKey, undefined);
		mounted = false; redraw = undefined; context = undefined; pending = 0; currentViews = []; initialized = false; published.clear();
	} };
}
