import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveHostPeerAliases } from "../src/runs/background/runner-aliases.ts";
import { readContract } from "../src/store.ts";

const host = process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT;
assert.ok(host, "Host SDK root is required");
assert.ok(process.env.PI_PROVIDER && process.env.PI_MODEL, "Run from a parent Pi shell exposing its selected model");
const root = mkdtempSync(join(tmpdir(), "generic-subagent-live-"));
const { aliases, missing } = resolveHostPeerAliases(host);
assert.deepEqual(missing, []);
const jiti = createJiti(import.meta.url, { alias: aliases });
const { ModelRuntime } = await jiti.import<any>("@earendil-works/pi-coding-agent");
const { registerExecutor } = await jiti.import<any>("../src/extension.ts");
const runtime = await ModelRuntime.create();
const available = await runtime.getAvailable();
const handlers: any[] = [];
let tool: any;
const notices: any[] = [];
registerExecutor({ registerTool: (t: any) => { tool = t; }, getThinkingLevel: () => process.env.PI_REASONING_LEVEL || "off", on: (name: string, cb: any) => { if (name === "session_shutdown") handlers.push(cb); }, sendMessage: (message: any) => notices.push(message) });
const ctx = { cwd: root, model: { provider: process.env.PI_PROVIDER, id: process.env.PI_MODEL }, modelRegistry: { getAvailable: () => available }, sessionManager: { getSessionId: () => randomSession } };
const randomSession = randomUUID();
const md = join(root, "要求.md");
writeFileSync(md, "只回复以下固定文本，不调用工具：LIVE_MARKDOWN_中文_OK", "utf8");
const results: any[] = [];
try {
  for (const [name, params] of [
    ["parent-default", { task: "这是通用子代理启动冒烟测试。不要调用任何工具，只回复 LIVE_PARENT_OK。" }],
    ["shared-lowCost-markdown", { task: "这是要求文件加载冒烟测试。按照附加要求的固定文本回复，不调用工具。", requirementsFile: md, model: "shared:lowCost" }],
  ] as const) {
    const response = await tool.execute(randomUUID(), { ...params, async: false, timeoutMs: 90000 }, undefined, undefined, ctx);
    const value = response.details;
    results.push({ name, ...value, model: readContract(value.run).model });
    console.log(JSON.stringify({ name, runId: value.run.id, status: value.run.status, model: results.at(-1).model, output: value.output, error: value.run.error }));
    assert.equal(value.run.status, "completed", JSON.stringify(value));
    assert.match(value.output, name === "parent-default" ? /LIVE_PARENT_OK/ : /LIVE_MARKDOWN_中文_OK/);
  }
  console.log(`LIVE_SMOKE_PASS ${root}`);
} finally {
  for (const shutdown of handlers) await shutdown();
  writeFileSync(join(root, "results.json"), JSON.stringify({ results, notices }, null, 2), "utf8");
  console.log(`Evidence: ${root}`);
}
