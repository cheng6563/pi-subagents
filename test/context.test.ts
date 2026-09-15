import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { forkMessages } from "../src/contract.ts";

test("fork preserves completed tool pairs but excludes the in-flight parent call and orphan results", () => {
	const messages = [
		{ role: "user", content: "parent history", timestamp: 1 },
		{ role: "assistant", content: [{ type: "toolCall", id: "done", name: "read", arguments: {} }], timestamp: 2 },
		{ role: "toolResult", toolCallId: "done", content: [{ type: "text", text: "read result" }], timestamp: 3 },
		{ role: "toolResult", toolCallId: "orphan", content: [{ type: "text", text: "orphan result" }], timestamp: 4 },
		{ role: "assistant", content: [{ type: "text", text: "handoff" }, { type: "toolCall", id: "pending", name: "subagent", arguments: {} }], timestamp: 5 },
	] as AgentMessage[];
	const fork = forkMessages(messages);
	assert.equal(fork.length, 4);
	assert.match(JSON.stringify(fork), /read result/);
	assert.doesNotMatch(JSON.stringify(fork), /orphan|pending/);
	assert.match(JSON.stringify(messages), /pending/);
});
