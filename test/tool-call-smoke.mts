import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { resolveHostPeerAliases } from "../src/runs/background/runner-aliases.ts";

const host = process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT;
assert.ok(host, "Host Pi npm SDK root is required");
const root = mkdtempSync(join(tmpdir(), "subagent-tool-call-smoke-"));
const { aliases, missing } = resolveHostPeerAliases(host);
assert.deepEqual(missing, []);
const jiti = createJiti(import.meta.url, { alias: aliases });
const sdk = await jiti.import<any>("@earendil-works/pi-coding-agent");
const { registerExecutor } = await jiti.import<any>("../src/extension.ts");
const runtime = await sdk.ModelRuntime.create();
const model = (await runtime.getAvailable()).find((m: any) => m.provider === process.env.PI_PROVIDER && m.id === process.env.PI_MODEL);
assert.ok(model, "Run in a Pi shell exposing the selected parent provider/model");
assert.equal(model.api, "openai-responses", "This smoke test targets OpenAI Responses tool serialization");
const cases = [
  {
    name: "default",
    keys: ["async", "task"],
    prompt: '只调用 subagent 工具一次，只传 task 和 async:false，不传其他参数。task 是：“不要调用任何工具。只根据当前工具定义判断：如果没有 subagent，且有 bash、read、write，则只回复 DEFAULT_TOOL_OK；否则如实报告异常。” 工具结束后简短报告结果，不再调用工具。',
    marker: "DEFAULT_TOOL_OK",
  },
  {
    name: "depth-two",
    keys: ["async", "maxDepth", "task"],
    prompt: '只调用 subagent 工具一次，仅传 task、async:false、maxDepth:2。task 是：本次是用户明确授权的两层派生测试，不修改文件，不使用 Bash。先调用 subagent，task 为“只回复不应执行”、async:false、maxDepth:3，预期被拒绝，若未拒绝立即报告失败并停止；随后调用 subagent，只传 async:false 和 task：“不要调用工具，只根据当前工具定义判断：若没有 subagent，且有 bash、read、write，则只回复 DEPTH2_TOOL_OK；否则如实报告异常。” 最后报告首次拒绝信息及第二次调用结果。工具结束后简短报告，不再调用工具。',
    marker: "DEPTH2_TOOL_OK",
  },
];
const summaries: any[] = [];
for (const spec of cases) {
  const directory = join(root, spec.name);
  mkdirSync(directory);
  const calls: any[] = [];
  const results: any[] = [];
  const schemas: any[] = [];
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
        if (calls.length > 1) return { block: true, reason: "Smoke test permits one parent call", terminate: true };
      });
      pi.on("tool_result", (event: any) => {
        if (event.toolName === "subagent") results.push({ isError: event.isError, details: event.details, content: event.content });
      });
    } }],
  });
  await loader.reload();
  const { session } = await sdk.createAgentSession({ cwd: directory, modelRuntime: runtime, model, thinkingLevel: "off", resourceLoader: loader, settingsManager, sessionManager: sdk.SessionManager.inMemory(directory), tools: ["subagent"] });
  const timer = setTimeout(() => void session.abort(), 150000);
  try {
    await session.bindExtensions({ mode: "print", onError: (error: any) => { throw new Error(String(error.error)); } });
    await session.prompt(spec.prompt, { expandPromptTemplates: false });
    assert.equal(calls.length, 1, JSON.stringify(calls));
    assert.deepEqual(Object.keys(calls[0]).sort(), spec.keys);
    assert.equal(schemas[0]?.[0]?.strict, false, "Responses tool must explicitly retain non-strict optional fields");
    assert.equal(results.length, 1);
    assert.equal(results[0].isError, false, JSON.stringify(results));
    const result = results[0].details;
    assert.equal(result.run.status, "completed", JSON.stringify(result));
    assert.match(result.output, new RegExp(spec.marker));
    const contract = JSON.parse(readFileSync(join(result.run.dir, "contract.json"), "utf8"));
    assert.equal(contract.model.provider, model.provider);
    assert.equal(contract.model.id, model.id);
    if (spec.name === "depth-two") {
      const events = readFileSync(join(result.run.dir, "events.jsonl"), "utf8");
      assert.match(events, /Cannot increase inherited maxDepth 2/);
      const children = join(result.run.dir, "children");
      const ids = readdirSync(children).filter(id => /^[\da-f-]{36}$/i.test(id));
      assert.equal(ids.length, 1, "Rejected increase must not start a child");
      const child = JSON.parse(readFileSync(join(children, ids[0]!, "contract.json"), "utf8"));
      assert.deepEqual(child.depth, { depth: 2, maxDepth: 2 });
      assert.equal(readFileSync(join(children, ids[0]!, "output.md"), "utf8").trim(), "DEPTH2_TOOL_OK");
    }
    summaries.push({ name: spec.name, status: "passed", runId: result.run.id, output: result.output });
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
