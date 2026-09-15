import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createJiti } from "jiti";
import { resolveHostPeerAliases } from "../src/runs/background/runner-aliases.ts";
import { resolveSharedModelReference } from "../src/shared/shared-models.ts";

const host = process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT;
assert.ok(host, "Host Pi npm SDK root is required");
const root = mkdtempSync(join(tmpdir(), "subagent-tool-call-smoke-"));
console.log(`EVIDENCE ${root}`);
const { aliases, missing } = resolveHostPeerAliases(host);
assert.deepEqual(missing, []);
const jiti = createJiti(import.meta.url, { alias: aliases });
const sdk = await jiti.import<any>("@earendil-works/pi-coding-agent");
const { registerExecutor } = await jiti.import<any>("../src/extension.ts");
const runtime = await sdk.ModelRuntime.create();
const model = (await runtime.getAvailable()).find((m: any) => m.provider === process.env.PI_PROVIDER && m.id === process.env.PI_MODEL);
assert.ok(model, "Run in a Pi shell exposing the selected parent provider/model");
assert.equal(model.api, "openai-responses", "This smoke test targets OpenAI Responses tool serialization");
const md = join(root, "要求.md");
writeFileSync(md, "不调用工具，只回复 MD_OPTIONS_中文_OK。", "utf8");
const cases = [
  {
    name: "default", keys: ["async", "task"], marker: "DEFAULT_TOOL_OK",
    prompt: '只调用 subagent 工具一次，只传 task 和 async:false，不传其他参数。task 是：“不要调用任何工具。只根据当前工具定义判断：如果没有 subagent，且有 bash、read、write，则只回复 DEFAULT_TOOL_OK；否则如实报告异常。” 工具结束后简短报告结果，不再调用工具。',
  },
  {
    name: "markdown-lowCost", keys: ["async", "options", "task"], marker: "MD_OPTIONS_中文_OK",
    prompt: `只调用 subagent 工具一次，传 task:"按照注入的要求回复，不调用工具"、async:false，以及 options 对象：requirementsFile=${JSON.stringify(md)}、model="shared:lowCost"。不要传其他参数。结束后报告实际结果，不再调用工具。`,
  },
  {
    name: "depth-two", keys: ["async", "options", "task"], marker: "DEPTH2_TOOL_OK",
    prompt: '只调用 subagent 工具一次，仅传 task、async:false、options:{maxDepth:2}。task 是：本次是用户明确授权的两层派生测试，不修改文件，不使用 Bash。先调用 subagent，task 为“只回复不应执行”、async:false、options:{maxDepth:3}，预期被拒绝，若未拒绝立即报告失败并停止；随后调用 subagent，只传 async:false 和 task：“不要调用工具，只根据当前工具定义判断：若没有 subagent，且有 bash、read、write，则只回复 DEPTH2_TOOL_OK；否则如实报告异常。” 最后报告首次拒绝信息及第二次调用结果。工具结束后简短报告，不再调用工具。',
  },
  { name: "interrupt-resume", keys: ["async", "options", "task"], marker: "RESUME_SNAPSHOT_OK", prompt: "" },
];
const selectedNames = new Set(process.argv.slice(2));
const summaries: any[] = [];
function readJson(file: string) { return JSON.parse(readFileSync(file, "utf8")); }
for (const spec of cases.filter(spec => selectedNames.size === 0 || selectedNames.has(spec.name))) {
  const directory = join(root, spec.name);
  mkdirSync(directory);
  const calls: any[] = [];
  const results: any[] = [];
  const schemas: any[] = [];
  const maxCalls = spec.name === "interrupt-resume" ? 3 : 1;
  const settingsManager = sdk.SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const loader = new sdk.DefaultResourceLoader({
    cwd: directory, agentDir: sdk.getAgentDir(), settingsManager,
    noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [{ name: "actual-subagent-tool-test", factory(pi: any) {
      registerExecutor(pi);
      pi.on("before_provider_request", (event: any) => {
        schemas.push(event.payload.tools?.filter((tool: any) => tool.name === "subagent"));
      });
      pi.on("tool_call", (event: any) => {
        if (event.toolName !== "subagent") return;
        calls.push(structuredClone(event.input));
        if (calls.length > maxCalls) return { block: true, reason: "Smoke test parent call limit reached", terminate: true };
      });
      pi.on("tool_result", (event: any) => {
        if (event.toolName === "subagent") results.push({ isError: event.isError, details: event.details, content: event.content });
      });
    } }],
  });
  await loader.reload();
  const { session } = await sdk.createAgentSession({ cwd: directory, modelRuntime: runtime, model, thinkingLevel: "off", resourceLoader: loader, settingsManager, sessionManager: sdk.SessionManager.inMemory(directory), tools: ["subagent"] });
  const timer = setTimeout(() => void session.abort(), 180000);
  try {
    await session.bindExtensions({ mode: "print", onError: (error: any) => { throw new Error(String(error.error)); } });
    let result: any;
    if (spec.name === "interrupt-resume") {
      const requirements = join(directory, "resume.md");
      writeFileSync(requirements, "完成任务时只回复 RESUME_SNAPSHOT_OK。", "utf8");
      writeFileSync(join(directory, "wait.py"), "import time\ntime.sleep(30)\n", "utf8");
      await session.prompt(`只调用 subagent 一次，async:true，options:{cwd:${JSON.stringify(directory)},requirementsFile:${JSON.stringify(requirements)},timeoutMs:90000}。task:"本次是用户授权的暂停恢复测试，请先使用 bash 工具运行 python3 wait.py，bash timeout 设为40秒；等待结束后按注入要求回复。不要额外执行任何操作。" 发起后立即报告ID，不等待，不再调用工具。`, { expandPromptTemplates: false });
      assert.equal(calls.length, 1);
      assert.deepEqual(Object.keys(calls[0]).sort(), spec.keys);
      assert.equal(results[0].isError, false, JSON.stringify(results));
      const launched = results[0].details;
      assert.equal(launched.status, "running");
      const deadline = Date.now() + 35000;
      let waiting = false;
      while (Date.now() < deadline) {
        const state = readJson(join(launched.dir, "status.json"));
        assert.equal(state.status, "running", "Child must remain running until interrupted");
        const events = readFileSync(join(launched.dir, "events.jsonl"), "utf8");
        if (/"type":"tool_execution_start"[^\n]*"toolName":"bash"/.test(events)) { waiting = true; break; }
        await delay(50);
      }
      assert.ok(waiting, "Child did not enter the bounded wait command");
      await session.prompt(`现在只调用 subagent 一次：action:"interrupt"、id:${JSON.stringify(launched.id)}。不要传 task、options 或其他参数，随后停止。`, { expandPromptTemplates: false });
      assert.equal(calls.length, 2);
      assert.deepEqual(Object.keys(calls[1]).sort(), ["action", "id"]);
      assert.equal(results[1].isError, false, JSON.stringify(results));
      assert.equal(results[1].details.status, "paused");
      const saved = readJson(join(launched.dir, "contract.json"));
      writeFileSync(requirements, "CHANGED_REQUIREMENTS_MUST_NOT_REPLACE_SNAPSHOT", "utf8");
      await session.prompt(`现在只调用 subagent 一次：action:"resume"、id:${JSON.stringify(launched.id)}、async:false、message:"之前的等待步骤不需要重做。请不要调用任何工具，直接按本次保存的要求回复。" 不传 task 或 options。结束后报告实际结果并停止。`, { expandPromptTemplates: false });
      assert.equal(calls.length, 3);
      assert.deepEqual(Object.keys(calls[2]).sort(), ["action", "async", "id", "message"]);
      assert.equal(results[2].isError, false, JSON.stringify(results));
      result = results[2].details;
      assert.notEqual(result.run.id, launched.id);
      assert.deepEqual(readJson(join(result.run.dir, "contract.json")), saved);
    } else {
      await session.prompt(spec.prompt, { expandPromptTemplates: false });
      assert.equal(calls.length, 1, JSON.stringify(calls));
      assert.deepEqual(Object.keys(calls[0]).sort(), spec.keys);
      assert.equal(results.length, 1);
      assert.equal(results[0].isError, false, JSON.stringify(results));
      result = results[0].details;
    }
    for (const schema of schemas) {
      assert.ok(schema?.[0], "Outgoing subagent schema missing");
      assert.equal(Object.hasOwn(schema[0], "strict"), false, "Validation must not depend on any explicit strict field or model compatibility override");
      assert.equal(schema[0].parameters.properties.options.additionalProperties, true);
    }
    assert.equal(result.run.status, "completed", JSON.stringify(result));
    assert.match(result.output, new RegExp(spec.marker));
    const contract = readJson(join(result.run.dir, "contract.json"));
    if (spec.name === "markdown-lowCost") {
      assert.equal(`${contract.model.provider}/${contract.model.id}`, resolveSharedModelReference("shared:lowCost"));
      assert.equal(contract.requirements.text, "不调用工具，只回复 MD_OPTIONS_中文_OK。");
    } else {
      assert.equal(contract.model.provider, model.provider);
      assert.equal(contract.model.id, model.id);
    }
    if (spec.name === "depth-two") {
      const events = readFileSync(join(result.run.dir, "events.jsonl"), "utf8");
      assert.match(events, /Cannot increase inherited maxDepth 2/);
      const children = join(result.run.dir, "children");
      const ids = readdirSync(children).filter(id => /^[\da-f-]{36}$/i.test(id));
      assert.equal(ids.length, 1, "Rejected increase must not start a child");
      const child = readJson(join(children, ids[0]!, "contract.json"));
      assert.deepEqual(child.depth, { depth: 2, maxDepth: 2 });
      assert.equal(readFileSync(join(children, ids[0]!, "output.md"), "utf8").trim(), "DEPTH2_TOOL_OK");
    }
    summaries.push({ name: spec.name, status: "passed", runId: result.run.id, output: result.output, toolCalls: calls });
    console.log(JSON.stringify(summaries.at(-1)));
  } finally {
    clearTimeout(timer);
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    writeFileSync(join(directory, "evidence.json"), JSON.stringify({ calls, results, schemas }, null, 2), "utf8");
  }
}
writeFileSync(join(root, "results.json"), JSON.stringify(summaries, null, 2), "utf8");
console.log(`ACTUAL_TOOL_CALL_PASS ${root}`);
