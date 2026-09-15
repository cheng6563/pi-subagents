import { test } from "node:test";
import assert from "node:assert/strict";
import { applyProgress, emptyProgress } from "../src/progress.ts";

test("live progress follows tools, streamed output and usage without copying reasoning", () => {
	const p = emptyProgress();
	applyProgress(p, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "reasoning body" } });
	assert.equal(p.activity, "思考中");
	assert.equal(p.text, "");
	applyProgress(p, { type: "tool_execution_start", toolName: "bash", args: { command: "echo OK" } });
	assert.equal(p.currentTool, "bash"); assert.equal(p.tools, 1);
	assert.match(p.toolInput!, /echo OK/);
	applyProgress(p, { type: "tool_execution_update", partialResult: { content: [{ type: "text", text: "partial" }] } });
	assert.equal(p.toolOutput, "partial");
	applyProgress(p, { type: "tool_execution_end", isError: true, result: { content: [{ type: "text", text: "error output" }] } });
	assert.equal(p.currentTool, undefined); assert.equal(p.activity, "工具失败");
	applyProgress(p, { type: "message_start", message: { role: "assistant" } });
	applyProgress(p, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x".repeat(5000) } });
	assert.equal(p.text.length, 4000);
	applyProgress(p, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "回答" }], usage: { totalTokens: 42, cost: { total: 0.01 } } } });
	assert.equal(p.text, "回答"); assert.equal(p.tokens, 42); assert.equal(p.cost, 0.01);
});
