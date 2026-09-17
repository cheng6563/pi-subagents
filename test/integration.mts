import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
import { resolveHostPeerAliases } from "../src/runs/background/runner-aliases.ts";
import { storeRoot, readContract } from "../src/store.ts";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const host = process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT;
assert.ok(host, "Set PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT to the installed Pi npm package");
const root = mkdtempSync(join(tmpdir(), "generic-subagent-integration-"));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
mkdirSync(join(agentDir, "extensions", "subagent"), { recursive: true });
mkdirSync(cwd);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.LOCALAPPDATA = root;
const { aliases, missing } = resolveHostPeerAliases(host);
assert.deepEqual(missing, []);
const jiti = createJiti(import.meta.url, { alias: aliases });
const { registerExecutor } = await jiti.import<any>("../src/extension.ts");
const { createEventBus } = await jiti.import<any>(join(host, "dist/core/event-bus.js"));
const captures: any[] = [];
let failedOnce = false;
const sockets = new Set<any>();
const server = createServer(async (req, res) => {
  try {
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(parts).toString("utf8"));
    captures.push(body);
    const exposedTools = body.tools.map((t: any) => t.function.name);
    for (const name of ["task_list", "task_add", "question", "scratchpad", "memory_write", "memory_forget", "memory_restore"]) {
      assert.ok(!exposedTools.includes(name), `Child must not expose ${name}`);
    }
    for (const name of ["probe", "late_probe", "memory_search", "memory_read", "memory_status"]) {
      assert.ok(exposedTools.includes(name), `Child must retain ${name}`);
    }
    const system = body.messages.filter((m: any) => m.role === "system" || m.role === "developer");
    assert.doesNotMatch(JSON.stringify(system), /PARENT_ONLY_(SNIPPET|GUIDELINE|HOOK)/);
    assert.match(JSON.stringify(system), /KEPT_PROBE_SNIPPET/);
    const users = body.messages.filter((m: any) => m.role === "user");
    const caseName = [...users].reverse().map((m: any) => JSON.stringify(m.content).match(/CASE_[A-Z_]+/)?.[0]).find(Boolean);
    const toolMessages = body.messages.filter((m: any) => m.role === "tool");
    const latestTool = toolMessages.at(-1);
    const hasTool = toolMessages.length > 0;
    if (caseName === "CASE_ASYNC_FAIL") { res.writeHead(503); res.end(JSON.stringify({ error: { message: "intentional async failure" } })); return; }
    if (caseName === "CASE_HOLD") { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(": waiting\n\n"); return; }
    if (caseName === "CASE_FAIL" && hasTool && !failedOnce) { failedOnce = true; res.writeHead(503); res.end(JSON.stringify({ error: { message: "intentional integration failure" } })); return; }
    let tool: { name: string; arguments: object } | undefined;
    let answer = `${caseName}_OK`;
    if (!hasTool) {
      if (caseName === "CASE_DEFAULT" || caseName === "CASE_FAIL") tool = { name: "probe", arguments: {} };
      if (["CASE_DEFAULT", "CASE_DISABLED", "CASE_LEAF"].includes(caseName)) {
        const names = body.tools.map((t: any) => t.function.name);
        assert.ok(!names.includes("subagent"), "leaf must not expose the subagent tool");
        for (const name of ["bash", "read", "write", "probe"]) assert.ok(names.includes(name), `${name} must remain available`);
      }
      if (["CASE_NEST", "CASE_INCREASE"].includes(caseName)) assert.ok(body.tools.some((t: any) => t.function.name === "subagent"));
      if (caseName === "CASE_REPORT") tool = { name: "subagent", arguments: { action: "report", message: "REPORT_MARKER" } };
      if (caseName === "CASE_INCREASE") tool = { name: "subagent", arguments: { task: "CASE_TOO_DEEP", options: { maxDepth: 999 }, async: false } };
      if (caseName === "CASE_NEST") tool = { name: "subagent", arguments: { task: "CASE_LEAF", async: false } };
      if (caseName === "CASE_CLI") tool = { name: "bash", arguments: { command: "pi() { printf 'PI_STUB_OK'; }; codex() { printf 'CODEX_STUB_OK'; }; pi; codex" } };
      if (caseName === "CASE_SCRIPT") tool = { name: "bash", arguments: { command: "bash launch.sh" } };
    } else {
      if (caseName === "CASE_INCREASE") assert.match(JSON.stringify(latestTool), /Cannot increase/);
      if (["CASE_CLI", "CASE_SCRIPT"].includes(caseName)) {
        assert.match(JSON.stringify(latestTool), /PI_STUB_OK/);
        assert.match(JSON.stringify(latestTool), /CODEX_STUB_OK/);
      }
      if (caseName === "CASE_NEST") assert.match(JSON.stringify(latestTool), /CASE_LEAF_OK/);
    }
    if (caseName === "CASE_TOO_DEEP") throw new Error("Depth boundary bypassed: forbidden provider request received");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const base = { id: randomUUID(), object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model };
    const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${randomUUID()}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { role: "assistant", content: answer };
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  } catch (error) { console.error("provider fixture:", error); res.writeHead(500); res.end(JSON.stringify({ error: { message: String(error) } })); }
});
server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address() as { port: number };
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "parent", retry: { enabled: false }, compaction: { enabled: false } }), "utf8");
writeFileSync(join(agentDir, "extensions", "subagent", "config.json"), JSON.stringify({ asyncByDefault: true, timeoutMs: 60000 }), "utf8");
writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "fixture-key", models: ["parent", "cheap"].map((id) => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsStore: false } })) } } }), "utf8");
writeFileSync(join(agentDir, "shared-models.json"), JSON.stringify({ lowCost: { provider: "fixture", model: "cheap" } }), "utf8");
writeFileSync(join(agentDir, "AGENTS.md"), "ENVIRONMENT_MARKER", "utf8");
const marker = join(root, "probe-count.txt");
writeFileSync(join(agentDir, "extensions", "probe.ts"), `import { Type } from 'typebox';\nimport { appendFileSync } from 'node:fs';\nexport default function(pi) { pi.registerTool({ name:'probe', label:'Probe', description:'Runtime probe', parameters:Type.Object({}), async execute() { appendFileSync(${JSON.stringify(marker)}, 'probe\\n', 'utf8'); return {content:[{type:'text',text:'PROBE_OK'}]}; } }); }`, "utf8");
// Parent-only tools deliberately carry both prompt metadata forms. Re-registering them
// after startup and during a tool call must not bypass SDK exclusions.
writeFileSync(join(agentDir, "extensions", "capabilities.ts"), `
import { Type } from 'typebox';
export default function(pi) {
  const blocked = ['question', 'scratchpad', 'memory_write', 'memory_forget', 'memory_restore'];
  const tool = name => ({ name, label:name, description:name, parameters:Type.Object({}),
    promptSnippet: blocked.includes(name) ? 'PARENT_ONLY_SNIPPET' : 'KEPT_PROBE_SNIPPET',
    promptGuidelines: blocked.includes(name) ? ['PARENT_ONLY_GUIDELINE'] : [],
    async execute() { return {content:[{type:'text',text:'OK'}]}; } });
  for (const name of [...blocked, 'memory_search', 'memory_read', 'memory_status']) pi.registerTool(tool(name));
  pi.on('session_start', () => { for (const name of [...blocked, 'late_probe']) pi.registerTool(tool(name)); });
  pi.on('tool_result', () => {
    for (const name of [...blocked, 'task_list', 'task_add']) {
      pi.registerTool({...tool(name), promptSnippet:'PARENT_ONLY_SNIPPET', promptGuidelines:['PARENT_ONLY_GUIDELINE']});
    }
    pi.setActiveTools([...pi.getActiveTools(), ...blocked, 'task_list', 'task_add']);
  });
}`, "utf8");
mkdirSync(join(agentDir, "extensions", "task-list"));
writeFileSync(join(agentDir, "extensions", "task-list", "index.ts"), `
import { Type } from 'typebox';
export default function(pi) {
  for (const name of ['task_list', 'task_add']) pi.registerTool({name, label:name, description:name,
    parameters:Type.Object({}), promptSnippet:'PARENT_ONLY_SNIPPET', promptGuidelines:['PARENT_ONLY_GUIDELINE'],
    async execute() { throw new Error('Child task tool ran'); }});
  pi.on('session_start', () => { throw new Error('Child task-list session_start ran'); });
  pi.on('before_agent_start', event => ({systemPrompt:event.systemPrompt + 'PARENT_ONLY_HOOK'}));
  pi.on('agent_settled', () => { throw new Error('Child task-list watchdog ran'); });
}
`, "utf8");
writeFileSync(join(cwd, "launch.sh"), "pi() { printf 'PI_STUB_OK'; }\ncodex() { printf 'CODEX_STUB_OK'; }\npi\ncodex\n", "utf8");
const md = join(cwd, "要求.md");
writeFileSync(md, "ORIGINAL_REQUIREMENTS_中文", "utf8");
const tools = new Map<string, any>();
const handlers = new Map<string, any[]>();
const notices: any[] = [];
const uiEntries: any[] = [];
const sessionId = randomUUID();
const pi = {
  events: createEventBus(),
  registerTool: (t: any) => tools.set(t.name, t),
  registerCommand() {}, registerMessageRenderer() {}, registerEntryRenderer() {},
  appendEntry: (customType: string, data: any) => uiEntries.push({ customType, data }),
  on: (name: string, cb: any) => { handlers.set(name, [...(handlers.get(name) ?? []), cb]); },
  getThinkingLevel: () => "off",
  sendMessage: (message: any) => notices.push(message),
};
registerExecutor(pi);
const ctx = { cwd, model: { provider: "fixture", id: "parent" }, modelRegistry: { getAvailable: () => [{ provider: "fixture", id: "parent" }, { provider: "fixture", id: "cheap" }] }, sessionManager: { getSessionId: () => sessionId, getEntries: () => [], getLeafId: () => null } };
const progressUpdates: any[] = [];
async function call(params: any) { const r = await tools.get("subagent").execute(randomUUID(), params, undefined, (update: any) => progressUpdates.push(update), ctx); return r.details; }
const results: any[] = [];
async function scenario(name: string, params: object, expected = "completed") {
  const result = await call({ task: name, async: false, ...(Object.keys(params).length ? { options: params } : {}) });
  assert.equal(result.run.status, expected, JSON.stringify(result));
  assert.equal(notices.filter(n => n.details.type === "complete" && n.details.runId === result.run.id).length, 0, "Synchronous launch must not enqueue completion notices");
  assert.ok(progressUpdates.some(u => u.details.run.id === result.run.id), "Synchronous execution must publish display updates");
  if (name === "CASE_DEFAULT") {
    const progress = JSON.parse(readFileSync(join(result.run.dir, "progress.json"), "utf8"));
    assert.equal(progress.activity, "completed");
    assert.ok(progress.tools >= 1 && progress.tokens > 0, "Real worker progress must include tools and usage");
    const events = readFileSync(join(result.run.dir, "events.jsonl"), "utf8");
    assert.match(events, /child_tool_policy_applied/);
    assert.match(events, /task-list/);
  }
  results.push({ name, runId: result.run.id, status: result.run.status, output: result.output });
  console.log(JSON.stringify(results.at(-1)));
  return result;
}
try {
  assert.deepEqual([...tools.keys()], ["subagent"]);
  for (const depth of [{ depth: 1, maxDepth: 1 }, { depth: 1, maxDepth: 2 }]) {
    const registered: string[] = [];
    const events: string[] = [];
    registerExecutor({ events: createEventBus(), registerTool: (t: any) => registered.push(t.name), on: (name: string) => events.push(name) }, { depth, root, report() {}, onController() {} });
    assert.deepEqual(registered, depth.depth < depth.maxDepth ? ["subagent"] : []);
    assert.ok(!events.includes("tool_call") && !events.includes("user_bash"));
  }
  if (process.env.SUBAGENT_INTEGRATION_CASE === "activity") {
    const taskPath = process.env.TASK_LIST_EXTENSION;
    assert.ok(taskPath, "Set TASK_LIST_EXTENSION to the task-list index.ts for cross-extension validation");
    const { loadExtensions } = await jiti.import<any>(join(host, "dist/core/extensions/loader.js"));
    const loaded = await loadExtensions([taskPath], cwd, pi.events);
    assert.deepEqual(loaded.errors, []);
    const taskExtension = loaded.extensions[0];
    const taskEntries: any[] = [];
    const wakes: any[] = [];
    loaded.runtime.appendEntry = (customType: string, data: any) => taskEntries.push({ type: "custom", customType, data });
    loaded.runtime.sendMessage = (message: any) => wakes.push(message);
    const taskCtx = { ...ctx, isIdle: () => true, hasPendingMessages: () => false,
      sessionManager: { ...ctx.sessionManager, getBranch: () => taskEntries },
      ui: { setStatus() {}, setWidget() {}, notify() {}, theme: { fg: (_color: string, text: string) => text, strikethrough: (text: string) => text } } };
    const emitTask = async (name: string) => { for (const cb of taskExtension.handlers.get(name) ?? []) await cb({ type: name }, taskCtx); };
    const count = (id = sessionId) => {
      let value = 0;
      pi.events.emit("subagent:activity-query", { sessionId: id, respond: (n: number) => { value = n; } });
      return value;
    };
    const until = async (predicate: () => boolean) => {
      const deadline = Date.now() + 15000;
      while (!predicate() && Date.now() < deadline) await delay(25);
      assert.ok(predicate(), "Activity condition did not settle before deadline");
    };
    try {
      await emitTask("session_start");
      assert.equal(count(), 0);
      const first = await call({ task: "CASE_HOLD" });
      const second = await call({ task: "CASE_HOLD" });
      assert.equal(count(), 2);
      assert.equal(count("other-session"), 0, "Other sessions cannot inherit our wait");
      await taskExtension.tools.get("task_list").definition.execute("set", { action: "set", items: ["A", "B"], start: true }, undefined, undefined, taskCtx);
      await emitTask("agent_settled");
      // Deliberately observe a full polling interval: this is an absence assertion, not readiness sleep.
      await delay(1200);
      assert.equal(wakes.length, 0, "Live workers must suppress actual task-list wakes");
      await call({ action: "cancel", id: first.id });
      assert.equal(count(), 1);
      await delay(1200);
      assert.equal(wakes.length, 0, "Finishing one worker must not release the other");
      await call({ action: "interrupt", id: second.id });
      assert.equal(count(), 0);
      await until(() => wakes.length === 1);
      assert.equal(wakes[0].customType, "task-list-watchdog");
      assert.equal(taskEntries.at(-1).data.paused, false);
      const resumed = await call({ action: "resume", id: second.id });
      assert.equal(count(), 1, "Resume must reacquire activity tracking");
      await call({ action: "cancel", id: resumed.id });
      assert.equal(count(), 0);
      const failed = await call({ task: "CASE_ASYNC_FAIL" });
      await until(() => count() === 0);
      assert.equal((await call({ action: "status", id: failed.id })).status, "failed");
      await scenario("CASE_DEFAULT", {});
      assert.equal(count(), 0, "Synchronous completion releases activity too");
      const broken = join(agentDir, "extensions", "broken.ts");
      writeFileSync(broken, "export default function() { throw new Error('ACTIVITY_BOOT_FAILURE'); }", "utf8");
      try { await assert.rejects(() => call({ task: "CASE_BOOT" }), /ACTIVITY_BOOT_FAILURE/); }
      finally { unlinkSync(broken); }
      assert.equal(count(), 0, "Startup failure must not leave a stuck activity count");
      const held = await call({ task: "CASE_HOLD" });
      assert.equal(count(), 1);
      for (const callback of handlers.get("session_shutdown") ?? []) await callback();
      assert.equal(count(), 0, "Shutdown releases the session's activity snapshot");
      results.push({ name: "cross_extension_activity_watchdog", status: "passed", shutdownRun: held.id });
    } finally { await emitTask("session_shutdown"); }
  } else if (process.env.SUBAGENT_INTEGRATION_CASE === "ui-progress") {
    const updates: any[] = [];
    const interactive = { ...ctx, hasUI: true, ui: { setWidget() {} } };
    const response = await tools.get("subagent").execute(randomUUID(), { task: "CASE_HOLD", async: false, options: { timeoutMs: 6000 } }, undefined, (update: any) => updates.push(update), interactive);
    assert.equal(response.details.run.status, "paused");
    assert.equal(updates.length, 1, "Interactive waiting must publish only the initial placeholder, not mutate history every tick");
    assert.equal(notices.filter(n => n.details.type === "complete" && n.details.runId === response.details.run.id).length, 0);
    assert.equal(response.details.uiResultAtTail, true);
    assert.equal(JSON.parse(response.content[0].text).uiResultAtTail, undefined, "UI routing metadata must not alter the model's tool result");
    assert.equal(uiEntries.filter(e => e.data.view.run.id === response.details.run.id).length, 1);
    const background = await tools.get("subagent").execute(randomUUID(), { task: "CASE_DEFAULT", async: true }, undefined, undefined, interactive);
    const deadline = Date.now() + 15000;
    while (!notices.some(n => n.details.type === "complete" && n.details.runId === background.details.id) && Date.now() < deadline) await delay(25);
    const completion = notices.filter(n => n.details.type === "complete" && n.details.runId === background.details.id);
    assert.equal(completion.length, 1, "UI-only entry must not replace the model's normal async completion delivery");
    assert.equal(completion[0].display, false, "The model notification must not duplicate the user's result card");
    assert.equal(uiEntries.filter(e => e.data.view.run.id === background.details.id).length, 1);
    results.push({ name: "interactive_static_history_and_completion_entries", status: "passed", updates: updates.length, uiEntries: uiEntries.length });
  } else if (process.env.SUBAGENT_INTEGRATION_CASE === "tools") {
    await scenario("CASE_DEFAULT", {});
    await scenario("CASE_DISABLED", {});
    await scenario("CASE_INCREASE", { maxDepth: 2 });
    await scenario("CASE_NEST", { maxDepth: 2 });
    await scenario("CASE_CLI", {});
    await scenario("CASE_SCRIPT", {});
  } else if (process.env.SUBAGENT_INTEGRATION_CASE === "wait") {
    const held = await call({ task: "CASE_HOLD" });
    const waiting = new AbortController();
    const pending = tools.get("subagent").execute(randomUUID(), { action: "wait", id: held.id }, waiting.signal, undefined, ctx);
    waiting.abort();
    await assert.rejects(() => pending, /Wait interrupted/);
    assert.equal((await call({ action: "status", id: held.id })).status, "running");
    assert.equal((await call({ action: "cancel", id: held.id })).status, "cancelled");
    assert.equal(notices.filter(n => n.details.type === "complete" && n.details.runId === held.id).length, 1, "Interrupted wait restores async notification");
    results.push({ name: "wait_interrupt_keeps_run_managed", status: "passed" });
  } else if (process.env.SUBAGENT_INTEGRATION_CASE === "fork") {
    const history = [
      { type: "message", id: "c1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "INHERITED_HISTORY_MARKER", timestamp: Date.now() } },
      { type: "message", id: "c2", parentId: "c1", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "toolCall", id: "pending-parent-call", name: "subagent", arguments: {} }], timestamp: Date.now() } },
    ];
    ctx.sessionManager.getEntries = () => history as any;
    ctx.sessionManager.getLeafId = () => "c2" as any;
    await scenario("CASE_FORK", { context: "fork" });
    assert.match(JSON.stringify(captures.at(-1)), /INHERITED_HISTORY_MARKER/);
    assert.doesNotMatch(JSON.stringify(captures.at(-1)), /pending-parent-call/);
  } else {
  await assert.rejects(() => call({ task: "CASE_DEFAULT", options: { requirementsFile: "missing.md" } }), /Cannot load requirementsFile/);
  await assert.rejects(() => call({ task: "CASE_DEFAULT", options: { model: "shared:absent" } }), /Unknown shared model/);
  await assert.rejects(() => call({ task: "CASE_DEFAULT", options: { model: "fixture/missing" } }), /unavailable/);
  await assert.rejects(() => call({ task: "CASE_DEFAULT", options: { maxDepth: 0 } }), /Invalid/);
  await assert.rejects(() => call({ task: "CASE_DEFAULT", options: { unexpected: true } }), /Invalid options/);
  assert.deepEqual(await call({ action: "list" }), []);
  await scenario("CASE_DEFAULT", {});
  assert.equal(captures[0].model, "parent");
  assert.match(JSON.stringify(captures[0]), /ENVIRONMENT_MARKER/);
  assert.ok(captures[0].tools.some((t: any) => t.function.name === "probe"));
  assert.ok(captures[0].tools.some((t: any) => t.function.name === "write"));
  if (!process.env.SUBAGENT_INTEGRATION_SMOKE_ONLY) {
  await scenario("CASE_MD", { requirementsFile: md, model: "shared:lowCost" });
  const mdRequest = captures.find((c) => JSON.stringify(c.messages).includes("CASE_MD"));
  assert.equal(mdRequest.model, "cheap");
  assert.match(JSON.stringify(mdRequest), /ORIGINAL_REQUIREMENTS_中文/);
  await scenario("CASE_DISABLED", {});
  await scenario("CASE_INCREASE", { maxDepth: 2 });
  await scenario("CASE_NEST", { maxDepth: 2 });
  await scenario("CASE_CLI", {});
  await scenario("CASE_SCRIPT", {});
  const failed = await scenario("CASE_FAIL", { requirementsFile: md, model: "shared:lowCost" }, "failed");
  const before = readFileSync(marker, "utf8");
  writeFileSync(md, "CHANGED_REQUIREMENTS", "utf8");
  writeFileSync(join(agentDir, "shared-models.json"), JSON.stringify({ lowCost: { provider: "fixture", model: "parent" } }), "utf8");
  await assert.rejects(() => call({ action: "resume", id: failed.run.id, options: { model: "fixture/parent" } }), /options cannot override/);
  const resumed = await call({ action: "resume", id: failed.run.id, async: false });
  assert.equal(resumed.run.status, "completed", JSON.stringify(resumed));
  assert.equal(notices.filter(n => n.details.type === "complete" && n.details.runId === resumed.run.id).length, 0, "Synchronous resume must not enqueue completion notices");
  assert.equal(readFileSync(marker, "utf8"), before, "resume must not repeat probe side effects");
  const saved = readContract(resumed.run);
  assert.equal(saved.model.id, "cheap");
  assert.equal(saved.requirements?.text, "ORIGINAL_REQUIREMENTS_中文");
  assert.match(JSON.stringify(captures.at(-1)), /ORIGINAL_REQUIREMENTS_中文/);
  assert.doesNotMatch(JSON.stringify(captures.at(-1)), /CHANGED_REQUIREMENTS/);
  await assert.rejects(() => call({ action: "resume", id: failed.run.id }), /already resumed/);
  results.push({ name: "failure_resume_snapshot_no_replay", runId: resumed.run.id, status: resumed.run.status });
  const held = await call({ task: "CASE_HOLD", options: { timeoutMs: 60000 } });
  const cancelled = await call({ action: "cancel", id: held.id });
  assert.equal(cancelled.status, "cancelled");
  await assert.rejects(() => call({ action: "resume", id: held.id }), /cannot be resumed/);
  const paused = await call({ task: "CASE_HOLD", options: { timeoutMs: 60000 } });
  assert.equal((await call({ action: "interrupt", id: paused.id })).status, "paused");
  assert.ok(notices.some((n) => n.details.type === "complete"));
  results.push({ name: "cancel_interrupt_notifications", status: "passed" });
  for (const [task, status] of [["CASE_MD", "completed"], ["CASE_ASYNC_FAIL", "failed"]]) {
    const background = await call({ task });
    const deadline = Date.now() + 30000;
    while ((await call({ action: "status", id: background.id })).status === "running" && Date.now() < deadline) await delay(25);
    // Worker writes terminal state before exit; wait for the completion delivery event itself.
    while (!notices.some(n => n.details.type === "complete" && n.details.runId === background.id) && Date.now() < deadline) await delay(25);
    assert.equal((await call({ action: "status", id: background.id })).status, status);
    assert.equal(notices.filter(n => n.details.type === "complete" && n.details.runId === background.id).length, 1);
  }
  const reported = await scenario("CASE_REPORT", { maxDepth: 2 });
  assert.ok(notices.some(n => n.details.runId === reported.run.id && n.details.message === "REPORT_MARKER"), "Explicit report survives synchronous completion suppression");
  results.push({ name: "async_success_failure_once_and_sync_report", status: "passed" });
  const historyEntry = { type: "message", id: "c1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "INHERITED_HISTORY_MARKER", timestamp: Date.now() } };
  ctx.sessionManager.getEntries = () => [historyEntry] as any;
  ctx.sessionManager.getLeafId = () => "c1" as any;
  await scenario("CASE_FRESH", {});
  assert.doesNotMatch(JSON.stringify(captures.at(-1)), /INHERITED_HISTORY_MARKER/);
  await scenario("CASE_FORK", { context: "fork" });
  assert.match(JSON.stringify(captures.at(-1)), /INHERITED_HISTORY_MARKER/);
  const brokenExtension = join(agentDir, "extensions", "broken.ts");
  writeFileSync(brokenExtension, "export default function() { throw new Error('INTENTIONAL_EXTENSION_LOAD_FAILURE'); }", "utf8");
  await assert.rejects(() => call({ task: "CASE_BOOT" }), /INTENTIONAL_EXTENSION_LOAD_FAILURE/);
  const startupFailed = (await call({ action: "list" }))[0];
  assert.equal(startupFailed.status, "failed");
  assert.equal(startupFailed.promptStarted, undefined);
  unlinkSync(brokenExtension);
  const startupResumed = await call({ action: "resume", id: startupFailed.id, async: false });
  assert.equal(startupResumed.run.status, "completed", JSON.stringify(startupResumed));
  results.push({ name: "startup_failure_resume", status: "passed", runId: startupResumed.run.id });
  const timeout = await call({ task: "CASE_HOLD", options: { timeoutMs: 6000 } });
  const timedOut = await call({ action: "wait", id: timeout.id });
  assert.equal(timedOut.run.status, "paused");
  assert.match(timedOut.run.error, /timed out/);
  assert.equal(notices.filter(n => n.details.type === "complete" && n.details.runId === timeout.id).length, 0, "Active wait owns completion");
  results.push({ name: "timeout_pause", status: "passed", runId: timeout.id });
  const interruptedCall = new AbortController();
  const duringStartup = tools.get("subagent").execute(randomUUID(), { task: "CASE_DEFAULT" }, interruptedCall.signal, undefined, ctx);
  interruptedCall.abort();
  await assert.rejects(() => duringStartup, /abort|interrupt|paused/i);
  results.push({ name: "startup_cancellation", status: "passed" });
  }
  }
  assert.ok(existsSync(storeRoot(sessionId)));
  writeFileSync(join(root, "results.json"), JSON.stringify({ passed: true, results, requestCount: captures.length }, null, 2), "utf8");
  console.log(`INTEGRATION_PASS ${root}`);
} finally {
  for (const callback of handlers.get("session_shutdown") ?? []) await callback();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((done) => server.close(() => done()));
  writeFileSync(join(root, "requests.json"), JSON.stringify(captures, null, 2), "utf8");
  console.log(`Evidence: ${root}`);
}
