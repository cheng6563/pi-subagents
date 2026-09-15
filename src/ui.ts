import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { keyText, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SelectList, Text, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
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

export function renderRunCall(args: Params, theme: Theme): Component {
	return dynamic(width => [truncateToWidth(`${theme.fg("toolTitle", theme.bold("subagents"))} ${args.action ?? (args.async === false ? "同步" : "启动")} ${args.id?.slice(0, 8) ?? ""}${args.task ? ` · ${brief(args.task, 72)}` : ""}`, width)]);
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
	return (result: { details?: unknown; content: unknown }, options: { expanded: boolean; isPartial?: boolean }, theme: Theme): Component => dynamic(width => {
		const data = result.details as { run?: Run; output?: string; id?: string; dir?: string; uiResultAtTail?: boolean } | Run[] | undefined;
		const runs = Array.isArray(data) ? data : data && ("run" in data && data.run ? [data.run] : "dir" in data && data.dir ? [data as Run] : []);
		if (!runs?.length) return options.isPartial ? [truncateToWidth("运行中 · 实时进度见底部或 /subagents", width)] : new Text(contentText(result.content), 0, 0).render(width);
		const lines: string[] = [];
		for (const snapshot of runs.slice(0, options.expanded ? runs.length : 5)) {
			try {
				const receipt = !Array.isArray(data) && data?.uiResultAtTail;
				if (receipt || options.isPartial || !isTerminal(snapshot.status)) {
					const view = readView(snapshot, false);
					// The receipt never changes when the worker finishes; results are appended separately.
					lines.push(`已提交 ${snapshot.id.slice(0, 8)} · ${view.model}`, theme.fg("dim", "实时进度见底部 · 结果见消息尾部 · /subagents 查看详情"));
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
	private transcript = false;
	private closed = false;
	private busy = false;
	private notice = "";
	private pageSize = 10;
	private transcriptCache?: { key: string; text: string };
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
			if (!this.views.some(v => v.run.id === this.selectedId)) this.selectedId = this.views[0]?.run.id;
		} catch (error) { this.notice = `读取失败：${String(error)}`; }
		this.redraw();
	}
	private selection(): SelectList {
		const t = this.theme;
		const list = new SelectList(this.views.map(v => ({ value: v.run.id, label: `${labels[v.run.status]} ${v.run.id.slice(0, 8)} ${brief(v.task, 64)}`, description: `${v.model} · ${elapsed(v.run)}` })), Math.min(5, Math.max(1, Math.floor(this.height() / 5))), {
			selectedPrefix: s => t.fg("accent", s), selectedText: s => t.fg("accent", s), description: s => t.fg("dim", s), scrollInfo: s => t.fg("dim", s), noMatch: s => s,
		});
		list.setSelectedIndex(Math.max(0, this.views.findIndex(v => v.run.id === this.selectedId)));
		list.onSelectionChange = item => { this.selectedId = item.value; this.scroll = 0; this.transcriptCache = undefined; };
		return list;
	}
	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") { this.closed = true; this.close(); return; }
		if (matchesKey(data, "tab") || matchesKey(data, "enter")) { this.transcript = !this.transcript; this.scroll = 0; }
		else if (matchesKey(data, "pageUp") || data === "K") this.scroll = Math.max(0, this.scroll - (data === "K" ? 1 : this.pageSize));
		else if (matchesKey(data, "pageDown") || data === "J") this.scroll += data === "J" ? 1 : this.pageSize;
		else if (data === "r" || data === "R") this.refresh();
		else if (["p", "D", "c", "s"].includes(data)) {
			const v = this.views.find(v => v.run.id === this.selectedId);
			if (v && !this.busy) {
				this.busy = true; this.notice = "处理中…";
				void this.action(({ p: "pause", D: "cancel", c: "resume", s: "steer" } as const)[data as "p" | "D" | "c" | "s"], v)
					.then(result => { this.notice = result === false ? "已取消操作" : "操作完成"; }, error => { this.notice = `操作失败：${String(error)}`; })
					.finally(() => { this.busy = false; this.refresh(); });
			}
		} else this.selection().handleInput(data === "j" ? "\x1b[B" : data === "k" ? "\x1b[A" : data);
		if (!this.closed) this.redraw();
	}
	private conversation(v: RunView): string {
		const path = v.run.sessionFile;
		if (!path || !existsSync(path)) return "会话尚未写入；概览中可查看实时输出。";
		const stat = statSync(path);
		const key = `${path}:${stat.mtimeMs}:${stat.size}`;
		if (this.transcriptCache?.key !== key) {
			const chunks: string[] = [];
			for (const line of readFileSync(path, "utf8").split("\n")) {
				try {
					const entry = JSON.parse(line);
					if (entry.type === "message" && entry.message) chunks.push(`${entry.message.role}${entry.message.toolName ? ` · ${entry.message.toolName}` : ""}\n${contentText(entry.message.content)}`);
				} catch { /* A live JSONL file can end with an incomplete entry. */ }
			}
			this.transcriptCache = { key, text: chunks.join("\n\n") };
		}
		return this.transcriptCache.text || "等待会话内容…";
	}
	render(width: number): string[] {
		if (width < 36 || this.height() < 12) return new Text("subagents 详情至少需要 36 列、12 行；Esc 关闭。", 0, 0).render(width);
		const t = this.theme;
		const v = this.views.find(v => v.run.id === this.selectedId);
		const header = [t.fg("borderMuted", "─".repeat(Math.max(0, width))), t.fg("accent", t.bold("subagents 运行详情")), ...this.selection().render(width), t.fg("borderMuted", "─".repeat(Math.max(0, width)))];
		let body: string[] = [];
		if (v) {
			const meta = `${state(v.run.status, t)} · ${stats(v)}\n${v.model} · ${v.thinking} · 深度 ${v.depth} · ${v.context}\nID ${v.run.id}${v.run.error ? `\n错误 ${v.run.error}` : ""}`;
			let text: string;
			try {
				const saved = isTerminal(v.run.status) && existsSync(v.run.outputPath) ? readFileSync(v.run.outputPath, "utf8") : "";
				text = this.transcript ? this.conversation(v) : `当前：${activity(v)}\n\n${isTerminal(v.run.status) && v.run.status !== "completed" ? "未完成输出" : "输出"}\n${saved || v.progress?.text || "等待输出…"}\n\n任务\n${v.task}${v.progress?.toolInput ? `\n\n最近工具输入：${v.progress.toolInput}` : ""}${v.progress?.toolOutput ? `\n\n最近工具输出：\n${v.progress.toolOutput}` : ""}\n\n目录 ${v.cwd}${v.requirements ? `\n要求 ${v.requirements}` : ""}\n产物 ${v.run.outputPath}${v.run.sessionFile ? `\n会话 ${v.run.sessionFile}` : ""}`;
			} catch (error) { text = `读取失败：${String(error)}`; }
			body = [...new Text(meta, 0, 0).render(width), ...new Text(text, 0, 0).render(width)];
		} else body = ["当前会话没有 subagents 运行。"];
		const help = new Text(`↑↓ 选择 · Enter/Tab ${this.transcript ? "概览" : "会话"} · PgUp/PgDn 滚动\np 暂停 · D 取消 · c 恢复 · s 补充 · r 刷新 · Esc 关闭${this.notice ? `\n${this.notice}` : ""}`, 0, 0).render(width);
		this.pageSize = Math.max(1, this.height() - header.length - help.length - 2);
		this.scroll = Math.min(this.scroll, Math.max(0, body.length - this.pageSize));
		return [...header, ...body.slice(this.scroll, this.scroll + this.pageSize), t.fg("dim", `${this.transcript ? "会话" : "概览"} ${this.scroll + 1}–${Math.min(body.length, this.scroll + this.pageSize)}/${body.length}`), ...help].map(line => truncateToWidth(line, width));
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
