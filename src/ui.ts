import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, SelectList, Text, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
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
	const p = v.progress;
	return `${elapsed(v.run)} · ${p?.tools ?? "—"} tools · ${p?.tokens ?? "—"} tokens${p?.cost ? ` · $${p.cost.toFixed(4)}` : ""}`;
}
function singleLine(text: string): string { return text.replace(/[\r\n]+/g, " "); }
function dynamic(render: (width: number) => string[]): Component { return { render, invalidate() {} }; }

export function renderRunCall(args: Params, theme: Theme): Component {
	return dynamic(width => new Text(`${theme.fg("toolTitle", theme.bold("子代理"))} ${args.action ?? (args.async === false ? "同步" : "启动")} ${args.id?.slice(0, 8) ?? ""}\n${args.task ?? ""}${args.options?.model ? `\n模型 ${args.options.model}` : ""}`, 0, 0).render(width));
}
export function createRunResultRenderer() {
	const readView = createViewReader();
	return (result: { details?: unknown; content: unknown }, options: { expanded: boolean; isPartial?: boolean }, theme: Theme): Component => dynamic(width => {
		const data = result.details as { run?: Run; output?: string; id?: string; dir?: string } | Run[] | undefined;
		const runs = Array.isArray(data) ? data : data && ("run" in data && data.run ? [data.run] : "dir" in data && data.dir ? [data as Run] : []);
		if (!runs?.length) return new Text(contentText(result.content), 0, 0).render(width);
		const box = new Container();
		for (const run of runs.slice(0, options.expanded ? runs.length : 5)) {
			try {
				const v = readView(run);
				box.addChild(new Text(`${state(run.status, theme)} ${theme.fg("accent", run.id.slice(0, 8))} · ${stats(v)}\n${v.model} · ${v.thinking} · 深度 ${v.depth}\n${singleLine(v.task)}`, 0, 0));
				if (run.error) box.addChild(new Text(theme.fg("error", run.error), 0, 0));
				if (!isTerminal(run.status)) box.addChild(new Text(theme.fg("muted", v.progress?.activity ?? "启动中"), 0, 0));
				const output = !Array.isArray(data) && data && "output" in data ? data.output : v.progress?.text;
				if (output) box.addChild(options.expanded ? new Markdown(output, 0, 0, getMarkdownTheme()) : new Text(output.split("\n").slice(0, 4).join("\n").slice(0, 600), 0, 0));
				if (options.expanded) box.addChild(new Text(theme.fg("dim", `ID ${run.id}\n产物 ${run.outputPath}\n/subagents-fleet 查看会话和控制运行`), 0, 0));
			} catch (error) { box.addChild(new Text(`${run.id} · ${run.status}\n${String(error)}`, 0, 0)); }
		}
		if (!options.expanded) box.addChild(new Text(theme.fg("dim", "/subagents-fleet 查看详情"), 0, 0));
		return box.render(width);
	});
}
export function renderRunNotice(notice: Notice, expanded: boolean, theme: Theme): Component {
	return dynamic(width => new Text(`${theme.fg("accent", "子代理")} ${notice.runId.slice(0, 8)} · ${state(String(notice.status ?? (notice.error ? "failed" : "报告")), theme)}${notice.message ? `\n${notice.message}` : ""}${notice.error ? `\n${notice.error}` : ""}${expanded && notice.outputPath ? `\n产物 ${notice.outputPath}` : ""}`, 0, 0).render(width));
}
export function renderRoster(views: RunView[], theme: Theme, width: number): string[] {
	const active = views.filter(v => !isTerminal(v.run.status));
	const recent = views.filter(v => isTerminal(v.run.status)).slice(0, 2);
	if (!views.length) return [];
	const visible = [...active, ...recent].slice(0, 5);
	const lines = [theme.fg("accent", `子代理 · ${active.length} 运行 · ${views.length} 记录 · /subagents-fleet`)];
	for (const v of visible) {
		lines.push(`${state(v.run.status, theme)} ${v.run.id.slice(0, 8)} · ${elapsed(v.run)} · ${singleLine(v.task)}`);
		lines.push(theme.fg("dim", `  ${v.model} · ${v.progress?.activity ?? labels[v.run.status]} · ${v.progress?.tools ?? "—"} tools`));
	}
	if (active.length > visible.length) lines.push(theme.fg("dim", `另有 ${active.length - visible.length} 个运行，打开详情查看`));
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
		const list = new SelectList(this.views.map(v => ({ value: v.run.id, label: `${labels[v.run.status]} ${v.run.id.slice(0, 8)} ${singleLine(v.task)}`, description: `${v.model} · ${elapsed(v.run)}` })), Math.min(5, Math.max(1, Math.floor(this.height() / 5))), {
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
					if (entry.type === "message" && entry.message) chunks.push(`## ${entry.message.role}${entry.message.toolName ? ` · ${entry.message.toolName}` : ""}\n${contentText(entry.message.content)}`);
				} catch { /* A live JSONL file can end with an incomplete entry. */ }
			}
			this.transcriptCache = { key, text: chunks.join("\n\n") };
		}
		return this.transcriptCache.text || "等待会话内容…";
	}
	render(width: number): string[] {
		if (width < 36 || this.height() < 12) return new Text("子代理详情至少需要 36 列、12 行；Esc 关闭。", 0, 0).render(width);
		const t = this.theme;
		const v = this.views.find(v => v.run.id === this.selectedId);
		const header = [t.fg("accent", t.bold("子代理运行详情")), ...this.selection().render(width), t.fg("borderMuted", "─".repeat(Math.max(0, width)))];
		let body: string[] = [];
		if (v) {
			const meta = `${state(v.run.status, t)} · ${stats(v)}\n${v.model} · ${v.thinking} · 深度 ${v.depth} · ${v.context}\nID ${v.run.id}\n目录 ${v.cwd}${v.requirements ? `\n要求 ${v.requirements}` : ""}\n产物 ${v.run.outputPath}${v.run.sessionFile ? `\n会话 ${v.run.sessionFile}` : ""}${v.run.error ? `\n错误 ${v.run.error}` : ""}`;
			let text: string;
			try { text = this.transcript ? this.conversation(v) : `## 任务\n${v.task}\n\n## 当前进度\n${v.progress?.activity ?? labels[v.run.status]}${v.progress?.toolInput ? `\n\n工具输入：${v.progress.toolInput}` : ""}${v.progress?.toolOutput ? `\n\n工具输出：\n${v.progress.toolOutput}` : ""}\n\n## 输出\n${isTerminal(v.run.status) && existsSync(v.run.outputPath) ? readFileSync(v.run.outputPath, "utf8") : v.progress?.text ?? ""}`; }
			catch (error) { text = `读取失败：${String(error)}`; }
			body = [...new Text(meta, 0, 0).render(width), ...new Markdown(text, 0, 0, getMarkdownTheme()).render(width)];
		} else body = ["当前会话没有子代理运行。"];
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
	const views = (ctx: ExtensionContext) => {
		const result: RunView[] = [];
		const visit = (runs: Run[]) => { for (const run of runs) { result.push(reader(run)); visit(listRuns(join(run.dir, "children"))); } };
		visit(getController(ctx).list());
		return result;
	};
	const refresh = () => {
		if (!context?.hasUI) return;
		try {
			const current = views(context);
			context.ui.setWidget(widgetKey, current.length && !fleetOpen ? (_tui, theme) => dynamic(width => renderRoster(current, theme, width)) : undefined);
		} catch (error) { context.ui.setWidget(widgetKey, [`子代理状态读取失败：${String(error)}`]); }
	};
	const attach = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		context = ctx;
		if (!timer) { timer = setInterval(refresh, 250); timer.unref(); }
		refresh();
	};
	const open = async (_args: string, ctx: ExtensionContext) => {
		if (!ctx.hasUI) { ctx.ui.notify("/subagents-fleet 需要交互界面；非交互模式请使用 subagent list/status/result。", "info"); return; }
		if (fleetOpen) return;
		attach(ctx); fleetOpen = true; refresh();
		let refreshTimer: ReturnType<typeof setInterval> | undefined;
		try {
			await ctx.ui.custom<void>((tui, theme, _keys, done) => {
				const component = new FleetComponent(() => views(ctx), theme, () => tui.requestRender(), () => done(), () => Math.max(12, tui.terminal.rows - 5), async (action, view) => {
					const c = getController(ctx);
					if (resolve(view.run.dir) !== resolve(c.root, view.run.id)) throw new Error("后代运行仅供查看；控制操作须交给它所属的父代理。");
					if (action === "steer") { const message = await ctx.ui.input("补充子代理任务", view.run.id); if (!message?.trim()) return false; c.steer(view.run.id, message); return; }
					if (!await ctx.ui.confirm({ pause: "暂停子代理", cancel: "取消子代理（不可恢复）", resume: "使用保存的会话恢复子代理" }[action], `${view.run.id}\n${view.task}`)) return false;
					if (action === "resume") await c.resume(view.run.id, undefined);
					else await c.cancel(view.run.id, action === "pause");
				});
				refreshTimer = setInterval(() => component.refresh(), 250);
				return component;
			});
		} finally { if (refreshTimer) clearInterval(refreshTimer); fleetOpen = false; refresh(); }
	};
	pi.registerCommand("subagents-fleet", { description: "查看子代理实时状态、完整会话及运行控制", handler: open });
	pi.registerCommand("subagents", { description: "打开子代理运行详情", handler: open });
	pi.registerMessageRenderer<Notice>("subagent-notice", (message, options, theme) => message.details ? renderRunNotice(message.details, options.expanded, theme) : new Text(contentText(message.content), 0, 0));
	pi.on("session_start", (_event, ctx) => attach(ctx));
	return { attach, dispose() { if (timer) clearInterval(timer); timer = undefined; context?.ui.setWidget(widgetKey, undefined); context = undefined; } };
}
