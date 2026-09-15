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

test("dock preview uses prose or a tool brief, never tool arguments or returned file content", () => {
	const p = emptyProgress();
	applyProgress(p, { type: "message_start", message: { role: "assistant" } });
	applyProgress(p, { type: "message_end", message: { role: "assistant", content: [
		{ type: "text", text: "先核对目录。\n\n接下来写入配置文件。" },
		{ type: "toolCall", name: "write", arguments: { path: "config.json", content: "PRIVATE_FILE_BODY" } },
	] } });
	applyProgress(p, { type: "tool_execution_start", toolName: "write", args: { path: "config.json", content: "PRIVATE_FILE_BODY" } });
	assert.match(p.previewText!, /接下来写入配置文件/);
	assert.doesNotMatch(p.previewText! + p.text, /PRIVATE_FILE_BODY|arguments/);
	applyProgress(p, { type: "tool_execution_end", result: { content: [{ type: "text", text: "PRIVATE_TOOL_RETURN" }] } });
	assert.doesNotMatch(p.previewText!, /PRIVATE_TOOL_RETURN/);
	assert.equal(p.toolOutput, "PRIVATE_TOOL_RETURN", "Full detail remains available outside the dock");
	applyProgress(p, { type: "message_start", message: { role: "assistant" } });
	applyProgress(p, { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "write", arguments: { content: "PRIVATE_FILE_BODY" } }] } });
	applyProgress(p, { type: "tool_execution_start", toolName: "write", args: { path: "config.json", content: "PRIVATE_FILE_BODY" } });
	assert.equal(p.previewText, "写入文件 config.json");
	applyProgress(p, { type: "tool_execution_start", toolName: "bash", args: { command: "PRIVATE_COMMAND_BODY" } });
	assert.equal(p.previewText, "执行命令");
	applyProgress(p, { type: "tool_execution_start", toolName: "unknown", args: { content: "PRIVATE_FILE_BODY" } });
	assert.equal(p.previewText, "执行工具 unknown");
	applyProgress(p, { type: "message_end", message: { role: "assistant", content: [], usage: { totalTokens: 10 } } });
	assert.equal(p.cost, undefined, "Missing pricing must not be presented as zero cost");
});
