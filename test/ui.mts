import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { createJiti } from "jiti";
import { resolveHostPeerAliases } from "../src/runs/background/runner-aliases.ts";
import { createRun, saveRun, listRuns, storeRoot, writeJson } from "../src/store.ts";
import { applyProgress, createViewReader, emptyProgress } from "../src/progress.ts";

const host = process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT;
assert.ok(host);
const root = mkdtempSync(join(tmpdir(), "subagent-ui-"));
process.env.LOCALAPPDATA = root;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const { aliases, missing } = resolveHostPeerAliases(host);
assert.deepEqual(missing, []);
const jiti = createJiti(import.meta.url, { alias: aliases });
const sdk = await jiti.import<any>("@earendil-works/pi-coding-agent");
const tui = await jiti.import<any>("@earendil-works/pi-tui");
sdk.initTheme("dark");
const { KeybindingsManager } = await jiti.import<any>(join(host, "dist/core/keybindings.js"));
const originalKeys = tui.getKeybindings();
tui.setKeybindings(new KeybindingsManager());
const theme = sdk.getSelectListTheme ? (await jiti.import<any>(join(host, "dist/modes/interactive/theme/theme.js"))).getThemeByName("dark") : undefined;
const ui = await jiti.import<any>("../src/ui.ts");
const session = sdk.SessionManager.create(root, join(root, "sessions"));
session.appendMessage({ role: "assistant", content: [{ type: "text", text: "UI fixture session" }], api: "openai-completions", provider: "fixture", model: "parent", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
const runsRoot = storeRoot(session.getSessionId());
const contract = (task: string, depth = 1) => ({ version: 1 as const, task, cwd: root, model: { provider: "fixture", id: "parent", thinking: "off" as const }, context: "fresh" as const, depth: { depth, maxDepth: 2 }, timeoutMs: 60000 });
const done = createRun(runsRoot, contract("UI_COMPLETED_CASE"));
done.status = "completed"; saveRun(done); writeFileSync(done.outputPath, "# Completed\nUI_OUTPUT_OK", "utf8");
const failed = createRun(runsRoot, contract("UI_FAILED_CASE"));
failed.status = "failed"; failed.error = "UI_FAILURE_DETAIL"; saveRun(failed);
const active = createRun(runsRoot, contract("UI_ACTIVE_CASE"));
active.status = "running"; active.pid = process.pid; active.sessionFile = join(active.dir, "fixture-session.jsonl");
writeFileSync(active.sessionFile, [{ type: "message", message: { role: "user", content: "UI_TRANSCRIPT_USER" } }, { type: "message", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "UI_TRANSCRIPT_TOOL_RESULT" }] } }].map(e => JSON.stringify(e)).join("\n"), "utf8");
saveRun(active);
const child = createRun(join(active.dir, "children"), contract("UI_NESTED_CASE", 2));
child.status = "completed"; saveRun(child);
writeJson(join(active.dir, "progress.json"), { ...emptyProgress(), tools: 2, currentTool: "bash", activity: "执行 bash", text: "UI_STREAMING_TEXT", previewText: "UI_STREAMING_TEXT", tokens: 42 });
const reader = createViewReader();
const commands = new Map<string, any>();
const handlers = new Map<string, any>();
const renderers = new Map<string, any>();
const entryRenderers = new Map<string, any>();
const completionEntries: any[] = [];
let widget: any;
let widgetComponent: any;
let widgetCalls = 0;
let placement: string | undefined;
let component: any;
let notices = 0;
let closeCustom: (() => void) | undefined;
const actions: any[] = [];
const controller = { root: runsRoot, list: () => listRuns(runsRoot), cancel: async (id: string, pause: boolean) => { actions.push([pause ? "pause" : "cancel", id]); }, resume: async (id: string) => { actions.push(["resume", id]); }, steer: (id: string, text: string) => { actions.push(["steer", id, text]); } };
const ctx = { hasUI: true, ui: { theme, setWidget: (_key: string, value: any, options?: any) => { widgetCalls++; widget = value; placement = options?.placement; widgetComponent = typeof value === "function" ? value({ terminal: { columns: 100, rows: 40 }, requestRender() {} }, theme) : undefined; }, notify() {}, confirm: async () => true, input: async () => "UI_STEER_MESSAGE", custom: (factory: any, options: any) => new Promise<void>(resolve => { assert.equal(options?.overlay, true, "Fullscreen viewport keys must be routed to the focused inspector overlay"); closeCustom = resolve; component = factory({ terminal: { rows: 40 }, requestRender() {} }, theme, {}, resolve); }) } };
const lifecycle = ui.registerRunUI({ registerCommand: (name: string, value: any) => commands.set(name, value), registerMessageRenderer: (name: string, value: any) => renderers.set(name, value), registerEntryRenderer: (name: string, value: any) => entryRenderers.set(name, value), appendEntry: (name: string, data: any) => { completionEntries.push({ customType: name, data }); session.appendCustomEntry(name, data); }, on: (name: string, cb: any) => handlers.set(name, cb), sendMessage: () => { notices++; } }, () => controller);
const frame = (name: string, c: any, width = 100) => {
  const lines = c.render(width);
  if (c === component) assert.ok(lines.length <= 36, "Inspector must respect the overlay height");
  for (const line of lines) assert.ok(tui.visibleWidth(line) <= width, `${name}: line exceeds ${width} columns`);
  const text = lines.map(stripVTControlCharacters).join("\n");
  writeFileSync(join(root, `${name}.txt`), text, "utf8");
  return text;
};
try {
  for (const [action, label] of Object.entries({ status: "查看状态", list: "列出任务", result: "读取结果", wait: "等待完成", report: "汇报", steer: "补充指令", resume: "恢复", interrupt: "暂停", cancel: "取消" })) {
    const rendered = frame(`call-${action}`, ui.renderRunCall({ action, id: active.id }, theme));
    assert.equal(rendered, `subagents ${label} ${active.id.slice(0, 8)}`);
    frame(`call-${action}-narrow`, ui.renderRunCall({ action, id: active.id }, theme), 24);
  }
  for (const [name, args, label] of [
    ["default", { task: "任务" }, "启动"],
    ["sync", { task: "任务", async: false }, "同步"],
    ["async", { task: "任务", async: true }, "启动"],
  ] as const) {
    assert.equal(frame(`call-${name}`, ui.renderRunCall(args, theme)), `subagents ${label}  · 任务`);
  }
  assert.deepEqual([...commands.keys()], ["subagents"]);
  handlers.get("session_start")({}, ctx);
  assert.equal(typeof widget, "function");
  const roster = frame("roster", widgetComponent);
  assert.equal(placement, "belowEditor");
  assert.equal(roster.split("\n").length, 3, "Only the header, active parent and its child occupy rows");
  assert.match(roster, /^subagents ·/);
  assert.match(roster, /UI_ACTIVE_CASE/);
  const mountedCalls = widgetCalls;
  const mountedComponent = widgetComponent;
  handlers.get("session_start")({}, ctx);
  assert.equal(widgetCalls, mountedCalls, "Refreshing live data must not remount the widget");
  assert.equal(widgetComponent, mountedComponent);
  for (const width of [24, 40, 80, 100]) {
    for (const text of ["", "short", "long".repeat(1000), "中文🙂\t".repeat(300), "\x1b[31mred\x1b[0m\n".repeat(30)]) {
      const view = { ...reader(active), progress: { ...emptyProgress(), text, previewText: text } };
      const lines = ui.renderRoster([view], theme, width);
      assert.equal(lines.length, 2, "Text updates never change one node's row count");
      assert.ok(lines.every((line: string) => tui.visibleWidth(line) <= width && !line.includes("\t")));
    }
    const preview = ui.tailPreview(Array.from({ length: 6 }, (_, i) => `ROW_${i} ${"中".repeat(200)}`).join("\n"), width);
    assert.equal(preview.hidden, 2);
    assert.deepEqual(preview.lines.map((line: string) => line.slice(0, 5)), ["ROW_2", "ROW_3", "ROW_4", "ROW_5"]);
  }
  assert.equal(completionEntries.length, 0, "Opening existing history does not replay old completions");
  const forest = [
    { ...reader(active), task: "ROOT", progress: { ...emptyProgress(), tools: 3, cost: 0.03, tokens: 9999, previewText: "不要这一段\n\n最新\n说明", toolInput: "PRIVATE_FILE_BODY", toolOutput: "PRIVATE_TOOL_RETURN" } },
    { ...reader(child), parentId: active.id, task: "CHILD" },
    { ...reader(active), run: { ...active, id: "grandchild" }, parentId: child.id, task: "GRANDCHILD" },
    { ...reader(active), run: { ...active, id: "other-root" }, task: "OTHER" },
  ];
  const forestLines = ui.renderRoster(forest, theme, 150).map(stripVTControlCharacters);
  assert.match(forestLines[1], /^├─ .*ROOT.*tools 3 · \$0\.03.*最新 说明/);
  assert.match(forestLines[2], /^│  └─ .*CHILD/);
  assert.match(forestLines[3], /^│     └─ .*GRANDCHILD/);
  assert.match(forestLines[4], /^└─ .*OTHER/);
  assert.doesNotMatch(forestLines.join("\n"), /不要这一段|PRIVATE_|9999|tokens|1\.2kt/);
  assert.equal(forestLines.length, 5);
  const many = Array.from({ length: 12 }, (_, i) => ({ ...reader(active), run: { ...active, id: `root-${i}` }, task: `ROOT_${i}` }));
  const overflow = ui.renderRoster(many, theme, 100).map(stripVTControlCharacters);
  assert.equal(overflow.length, ui.LIVE_PANEL_MAX_ROWS);
  assert.match(overflow.at(-1)!, /^more 6 agents\.\.\.$/);
  for (const count of [1, 2, 5, 7, 8, 12, 200, 2, 1, 0]) {
    const peers = Array.from({ length: count }, (_, i) => ({ ...reader(active), run: { ...active, id: `peer-${i}` }, task: `PEER_${i}` }));
    const lines = ui.renderRoster(peers, theme, 100).map(stripVTControlCharacters);
    assert.equal(lines.length, count ? Math.min(count + 1, ui.LIVE_PANEL_MAX_ROWS) : 0);
    assert.ok(lines.every((line: string) => line.trim().length > 0), "The dock must not pad unused rows");
    if (count > 7) assert.equal(lines.at(-1), `more ${count - 6} agents...`);
  }
  const renderResult = ui.createRunResultRenderer();
  assert.match(frame("completed-card", renderResult({ details: { run: done, output: "# Completed\nUI_OUTPUT_OK" } }, { expanded: true }, theme)), /UI_OUTPUT_OK/);
  assert.match(frame("failed-card", renderResult({ details: { run: failed, output: "" } }, { expanded: false }, theme)), /UI_FAILURE_DETAIL/);
  const pending = commands.get("subagents").handler("", ctx);
  assert.ok(component);
  assert.match(frame("fleet", component), /fixture\/parent/);
  component.handleInput("2");
  assert.match(frame("fleet-output", component), /UI_STREAMING_TEXT/);
  component.handleInput("1");
  assert.match(frame("fleet-transcript", component), /UI_TRANSCRIPT_TOOL_RESULT/);
  component.handleInput("\x1b[C");
  assert.match(frame("nested", component), /深度 2\/2/);
  component.handleInput("\x1b[D");
  for (const key of ["p", "D", "c", "s"]) { component.handleInput(key); await new Promise(resolve => setImmediate(resolve)); }
  assert.deepEqual(actions.map(a => a[0]), ["pause", "cancel", "resume", "steer"]);
  assert.equal(actions[3][2], "UI_STEER_MESSAGE");
  ctx.ui.confirm = async () => false;
  component.handleInput("p");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(actions.length, 4, "Declined confirmation must not dispatch control");
  assert.match(frame("declined-control", component), /已取消操作/);
  frame("narrow", component, 24);
  for (const width of [36, 60, 80, 120]) frame(`width-${width}`, component, width);
  component.handleInput("\x1b");
  await pending;
  assert.equal(typeof widget, "function", "Closing inspector restores roster");
  assert.equal(notices, 0, "UI refreshes must never notify the model");
  assert.match(frame("notice", renderers.get("subagent-notice")({ details: { type: "complete", runId: done.id, status: "completed", outputPath: done.outputPath } }, { expanded: false }, theme)), /已完成/);
  assert.equal(reader(active).progress?.tools, 2);
  const longTask = "这是一次 UI 多行输出测试。" + "HIDDEN_LONG_INSTRUCTION ".repeat(80);
  const multiline = createRun(join(root, "render-only"), contract(longTask));
  multiline.status = "completed"; saveRun(multiline);
  const numbers = Array.from({ length: 101 }, (_, i) => String(i).padStart(3, "0"));
  writeFileSync(multiline.outputPath, numbers.join("\n"), "utf8");
  const callFrame = frame("multiline-call", ui.renderRunCall({ task: longTask, async: false }, theme));
  assert.equal(callFrame.split("\n").length, 1);
  assert.match(callFrame, /^subagents /);
  assert.doesNotMatch(callFrame, /HIDDEN_LONG_INSTRUCTION/);
  const result = { details: { run: multiline, output: numbers.join("\n") } };
  const collapsed = frame("multiline-collapsed", renderResult(result, { expanded: false }, theme));
  assert.ok(collapsed.split("\n").length <= 7);
  assert.doesNotMatch(collapsed, /HIDDEN_LONG_INSTRUCTION|这是一次/);
  assert.match(collapsed, /前 97 行已折叠.*ctrl\+o 展开/);
  assert.deepEqual(collapsed.split("\n").map(line => line.trim()).filter(line => /^\d{3}$/.test(line)), numbers.slice(-4));
  tui.setKeybindings(new KeybindingsManager({ "app.tools.expand": "ctrl+e" }));
  assert.match(frame("multiline-custom-key", renderResult(result, { expanded: false }, theme)), /ctrl\+e 展开/);
  tui.setKeybindings(new KeybindingsManager());
  const streamingRun = createRun(join(root, "render-only"), contract("STREAMING"));
  streamingRun.status = "running"; saveRun(streamingRun);
  const streaming = { details: { run: streamingRun, output: numbers.slice(0, 51).join("\n") } };
  for (const expanded of [false, true]) {
    const streamingFrame = frame(`streaming-history-${expanded}`, renderResult(streaming, { expanded, isPartial: true }, theme));
    assert.equal(streamingFrame.split("\n").length, 2, "Streaming history stays fixed even when other tools are expanded");
    assert.equal(streamingFrame.split("\n")[1], "STREAMING");
    assert.doesNotMatch(streamingFrame, /实时进度见底部|结果见消息尾部|查看详情/);
    assert.doesNotMatch(streamingFrame, /047|048|049|050/);
  }
  writeFileSync(join(streamingRun.dir, "progress.json"), "incomplete display snapshot", "utf8");
  const independentHistory = frame("history-with-unreadable-progress", renderResult(streaming, { expanded: false, isPartial: true }, theme));
  assert.equal(independentHistory.split("\n").length, 2, "History must not depend on the live display snapshot");
  assert.equal(independentHistory.split("\n")[1], "STREAMING");
  writeJson(join(streamingRun.dir, "progress.json"), emptyProgress());
  for (const [index, task] of ["首句。第二句仍需显示", "第一行\r\n第二行\t第三行", "中文🙂\n".repeat(100), "\x1b[31m任务\x1b[0m\n".repeat(100)].entries()) {
    const run = createRun(join(root, "render-only"), contract(task));
    for (const width of [24, 40, 100]) for (const expanded of [false, true]) {
      const receipt = frame(`task-receipt-${index}-${width}-${expanded}`, renderResult({ details: { run, uiResultAtTail: true } }, { expanded }, theme), width);
      const lines = receipt.split("\n");
      assert.equal(lines.length, 2, "The task prompt occupies exactly one row, even when expanded");
      assert.equal(lines[1], stripVTControlCharacters(tui.truncateToWidth(stripVTControlCharacters(task).replace(/[\r\n\t]+/g, " "), width)));
      assert.doesNotMatch(receipt, /实时进度见底部|结果见消息尾部|查看详情/);
    }
  }
  assert.equal(frame("pending-without-run", renderResult({ content: [] }, { expanded: false, isPartial: true }, theme)), "运行中");
  const expanded = frame("multiline-expanded", renderResult(result, { expanded: true }, theme));
  assert.deepEqual(expanded.split("\n").map(line => line.trim()).filter(line => /^\d{3}$/.test(line)), numbers, "All 100 literal newlines must survive expansion");
  const multilineFleet = new ui.FleetComponent(() => [reader(multiline)], theme, () => {}, () => {}, () => 35, async () => {});
  const seen = new Set<string>();
  multilineFleet.handleInput("\x1b[H");
  for (let page = 0; page < 8; page++) {
    for (const line of frame(`multiline-page-${page}`, multilineFleet).split("\n").map(line => line.replace(/^│ | │$/g, "").trim())) if (/^\d{3}$/.test(line)) seen.add(line);
    multilineFleet.handleInput("\x1b[6~");
  }
  assert.deepEqual([...seen].sort(), numbers);
  multilineFleet.dispose();
  const staleFailed = createRun(join(root, "render-only"), contract("FAILED_PARTIAL"));
  staleFailed.status = "failed"; staleFailed.error = "fixture failure"; saveRun(staleFailed);
  writeJson(join(staleFailed.dir, "progress.json"), { ...emptyProgress(), activity: "输出中", text: numbers.slice(0, 48).join("\n"), tokens: 0 });
  const failedPreview = frame("failed-partial", renderResult({ details: { run: staleFailed, output: "" } }, { expanded: false }, theme));
  assert.match(failedPreview, /未完成输出/);
  assert.doesNotMatch(failedPreview, /输出中|0 tokens/);
  assert.equal(ui.renderRoster([reader(staleFailed), reader(done)], theme, 100).length, 0, "Idle roster must render nothing");
  const failedFleet = new ui.FleetComponent(() => [reader(staleFailed)], theme, () => {}, () => {}, () => 35, async () => {});
  const failedFrame = frame("failed-authoritative-state", failedFleet);
  assert.match(failedFrame, /失败 · 深度/);
  assert.match(failedFrame, /错误：fixture failure/);
  assert.doesNotMatch(failedFrame, /输出中/);
  failedFleet.dispose();
  const liveTask = "INSPECTOR_TASK\n" + "PROMPT_ONLY\n".repeat(120);
  const live = createRun(join(root, "render-only"), contract(liveTask));
  live.status = "running";
  live.sessionFile = join(live.dir, "session.jsonl");
  const reply = Array.from({ length: 120 }, (_, i) => `REPLY_${String(i).padStart(3, "0")}`).join("\n");
  writeFileSync(live.sessionFile, [
    { type: "message", message: { role: "user", content: liveTask } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: reply }] } },
  ].map(entry => JSON.stringify(entry)).join("\n") + "\n", "utf8");
  let liveView = reader(live);
  const inspector = new ui.FleetComponent(() => [reader(failed), liveView], theme, () => {}, () => {}, () => 36, async () => {});
  const latest = frame("inspector-latest", inspector);
  assert.match(latest, /REPLY_119/);
  assert.doesNotMatch(latest, /^│ PROMPT_ONLY|r 刷新/m);
  assert.match(latest, /代理 2\/2/);
  assert.match(latest, /跟随最新/);
  assert.equal(latest.split("\n").length, 36);
  assert.ok(latest.split("\n").every(line => /^[┌├│└].*[┐┤│┘]$/.test(line)), "Every panel row has a complete frame");
  const range = (text: string) => text.match(/会话 (\d+)–(\d+)\/(\d+)/)!.slice(1).map(Number);
  inspector.handleInput("\x1b[5~");
  const previous = frame("inspector-page-up", inspector);
  assert.ok(range(previous)[0] < range(latest)[0]);
  assert.match(previous, /历史快照/);
  liveView = { ...liveView, progress: { ...emptyProgress(), text: "NEW_LIVE_OUTPUT", previewText: "NEW_LIVE_OUTPUT" } };
  inspector.refresh();
  const refreshed = frame("inspector-reading-anchor", inspector);
  assert.deepEqual(range(refreshed), range(previous));
  assert.deepEqual(refreshed.match(/^│ REPLY_.*$/gm), previous.match(/^│ REPLY_.*$/gm), "Automatic updates preserve visible content while status remains live");
  inspector.handleMouse({ type: "wheel", wheelDelta: -1 });
  assert.equal(range(frame("inspector-wheel-up", inspector))[0], range(previous)[0] - 3);
  inspector.handleInput("\x1b[F");
  assert.match(frame("inspector-follow-again", inspector), /NEW_LIVE_OUTPUT/);
  inspector.handleInput("3");
  assert.match(frame("inspector-task", inspector), /任务提示.*\n[\s\S]*INSPECTOR_TASK/);
  inspector.handleInput("\x1b[6~");
  assert.match(frame("inspector-task-page", inspector), /PROMPT_ONLY/);
  inspector.handleInput("1");
  inspector.handleInput("\x1b[D");
  assert.match(frame("inspector-other-agent", inspector), /UI_FAILURE_DETAIL/);
  for (const width of [36, 60, 80, 120]) {
    const lines = inspector.render(width);
    assert.equal(lines.length, 36);
    assert.ok(lines.every((line: string) => tui.visibleWidth(line) === width));
  }
  inspector.dispose();
  const rollingSession = join(live.dir, "rolling-session.jsonl");
  const sessionMessage = (role: string, content: unknown) => JSON.stringify({ type: "message", message: { role, content } }) + "\n";
  writeFileSync(rollingSession, sessionMessage("user", "ROLLING_TASK"), "utf8");
  const rollingProgress = emptyProgress();
  const rollingView = { ...reader(live), run: { ...live, sessionFile: rollingSession }, progress: rollingProgress };
  const rollingFleet = new ui.FleetComponent(() => [rollingView], theme, () => {}, () => {}, () => 36, async () => {});
  const rollingText = Array.from({ length: 500 }, (_, i) => `LIVE_${String(i).padStart(3, "0")}`).join("\n");
  applyProgress(rollingProgress, { type: "message_start", message: { role: "assistant" } });
  applyProgress(rollingProgress, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: rollingText } });
  frame("rolling-latest", rollingFleet);
  rollingFleet.handleInput("\x1b[5~");
  const frozen = frame("rolling-history", rollingFleet);
  const moreText = "\nLIVE_500\nLIVE_501\nLIVE_502";
  applyProgress(rollingProgress, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: moreText } });
  rollingFleet.refresh();
  assert.equal(frame("rolling-history-after-delta", rollingFleet), frozen, "Rolling progress truncation must not move visible content");
  writeFileSync(rollingSession, sessionMessage("user", "ROLLING_TASK") + sessionMessage("assistant", rollingText + moreText), "utf8");
  applyProgress(rollingProgress, { type: "message_end", message: { role: "assistant", content: rollingText + moreText } });
  rollingFleet.refresh();
  assert.equal(frame("rolling-history-after-persist", rollingFleet), frozen, "Persisting the full message must not replace the historical snapshot");
  rollingFleet.handleInput("\x1b[F");
  assert.match(frame("rolling-rejoin-live", rollingFleet), /LIVE_502/);
  applyProgress(rollingProgress, { type: "tool_execution_start", toolName: "bash", args: { command: "fixture" } });
  applyProgress(rollingProgress, { type: "tool_execution_update", partialResult: { content: [{ type: "text", text: "LIVE_TOOL_RESULT_123" }] } });
  for (const tab of ["1", "2"]) {
    rollingFleet.handleInput(tab);
    assert.match(frame(`live-tool-tab-${tab}`, rollingFleet), /工具 · bash · 运行中[\s\S]*LIVE_TOOL_RESULT_123/);
  }
  writeFileSync(rollingSession, readFileSync(rollingSession, "utf8") + sessionMessage("toolResult", "LIVE_TOOL_RESULT_123"), "utf8");
  applyProgress(rollingProgress, { type: "tool_execution_end", result: { content: [{ type: "text", text: "LIVE_TOOL_RESULT_123" }] } });
  rollingFleet.handleInput("1");
  const settledTool = frame("settled-tool", rollingFleet);
  assert.equal(settledTool.match(/LIVE_TOOL_RESULT_123/g)?.length, 1, "Saved tool results must not also appear as live output");
  assert.doesNotMatch(settledTool, /工具 · bash · 运行中/);
  rollingFleet.dispose();
  const receiptBefore = renderResult({ details: { ...active, uiResultAtTail: true } }, { expanded: false }, theme).render(100);
  writeFileSync(active.outputPath, "COMPLETION_UI_ONLY_MARKER", "utf8");
  active.status = "completed"; saveRun(active);
  handlers.get("session_start")({}, ctx);
  assert.equal(widget, undefined, "All terminal runs must remove the widget, not leave an empty component");
  assert.equal(completionEntries.length, 1);
  assert.equal(completionEntries[0].customType, ui.COMPLETION_ENTRY);
  const completion = frame("completion-entry", entryRenderers.get(ui.COMPLETION_ENTRY)({ data: completionEntries[0].data }, { expanded: false }, theme));
  assert.match(completion, /COMPLETION_UI_ONLY_MARKER/);
  const receiptAfter = renderResult({ details: { run: active, output: "COMPLETION_UI_ONLY_MARKER", uiResultAtTail: true } }, { expanded: false }, theme).render(100);
  assert.deepEqual(receiptAfter, receiptBefore, "Synchronous final results must not replace the launch receipt");
  lifecycle.refresh(); lifecycle.refresh();
  assert.equal(completionEntries.length, 1, "One durable entry per terminal run");
  const modelContext = sdk.buildSessionContext(session.getEntries(), session.getLeafId()).messages;
  assert.doesNotMatch(JSON.stringify(modelContext), /COMPLETION_UI_ONLY_MARKER|subagents-completion/);
  assert.ok(session.getEntries().some((entry: any) => entry.type === "custom" && entry.data?.output === "COMPLETION_UI_ONLY_MARKER"));
  const reopened = sdk.SessionManager.open(session.getSessionFile(), join(root, "sessions"));
  const restored = reopened.getEntries().find((entry: any) => entry.customType === ui.COMPLETION_ENTRY);
  assert.match(frame("restored-completion-entry", entryRenderers.get(ui.COMPLETION_ENTRY)(restored, { expanded: true }, theme)), /COMPLETION_UI_ONLY_MARKER/);
  const batchParent = createRun(runsRoot, contract("BATCH_PARENT"));
  batchParent.status = "running"; saveRun(batchParent);
  const releaseBatch = lifecycle.beginLaunch(ctx);
  const batchChild = createRun(join(batchParent.dir, "children"), contract("BATCH_CHILD", 2));
  batchChild.status = "completed"; saveRun(batchChild);
  const batchPeer = createRun(runsRoot, contract("BATCH_PEER"));
  batchPeer.status = "failed"; saveRun(batchPeer);
  lifecycle.refresh();
  assert.equal(completionEntries.length, 3, "Concurrent and nested terminal records each append once, including a fast unseen child");
  assert.equal(completionEntries.find(e => e.data.view.run.id === batchChild.id).data.view.parentId, batchParent.id);
  batchParent.status = "completed"; saveRun(batchParent); releaseBatch();
  assert.equal(completionEntries.length, 4);
  assert.equal(widget, undefined);
  const history = commands.get("subagents").handler("", ctx);
  assert.match(frame("idle-history", component), /subagents 运行详情/);
  component.handleInput("\x1b");
  await history;
  assert.equal(widget, undefined, "Closing history while idle must not restore a status bar");
  const idleCalls = widgetCalls;
  // Observe longer than two former polling periods: no hidden idle redraw loop may remain.
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal(widgetCalls, idleCalls);
  const release = lifecycle.beginLaunch(ctx);
  assert.equal(typeof widget, "function", "A new launch must restart the dock after idle");
  assert.match(frame("launch-pending", widgetComponent), /启动中/);
  assert.equal(widgetComponent.render(100).length, 1, "Pending launch only needs its header");
  active.status = "running"; saveRun(active);
  release();
  assert.equal(typeof widget, "function", "Active runs must retain the widget after handoff");
  console.log(`UI_COMPONENTS_PASS ${root}`);
} finally {
  component?.dispose(); closeCustom?.(); lifecycle.dispose(); tui.setKeybindings(originalKeys);
  assert.equal(widget, undefined);
}
writeJson(join(process.env.PI_CODING_AGENT_DIR, "settings.json"), { quietStartup: true, defaultProvider: "fixture", defaultModel: "parent" });
writeJson(join(process.env.PI_CODING_AGENT_DIR, "models.json"), { providers: { fixture: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "fixture", models: [{ id: "parent", name: "UI Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } });
writeJson(join(root, "fixture.json"), { root, agentDir: process.env.PI_CODING_AGENT_DIR, session: session.getSessionFile(), activeRun: join(active.dir, "status.json"), progress: join(active.dir, "progress.json"), extension: resolve("index.ts"), cli: join(host, "dist/cli.js") });
console.log(`PTY_FIXTURE ${join(root, "fixture.json")}`);
