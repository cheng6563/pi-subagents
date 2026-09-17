import test from "node:test";
import assert from "node:assert/strict";
import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { CHILD_EXCLUDED_TOOLS, filterChildExtensions } from "../src/runs/shared/child-tool-policy.ts";

test("child exclusions are the parent-owned tools, not execution or memory lookup", () => {
	assert.deepEqual(CHILD_EXCLUDED_TOOLS, ["task_list", "task_add", "question", "scratchpad", "memory_write", "memory_forget", "memory_restore"]);
	for (const name of ["read", "write", "bash", "subagent", "memory_read", "memory_search", "memory_status", "mcp"]) {
		assert.ok(!CHILD_EXCLUDED_TOOLS.includes(name));
	}
});

test("task-list lifecycle is excluded on Windows and POSIX without mutating the parent resources", () => {
	for (const path of ["C:\\agent\\extensions\\task-list\\index.ts", "/agent/extensions/task-list/index.ts"]) {
		const task = { resolvedPath: path, handlers: new Map([["session_start", [() => {}]]]) };
		const memory = { resolvedPath: "/agent/extensions/unified-memory/index.ts" };
		const other = { resolvedPath: "/project/my-task-list/index.ts" };
		const base = { extensions: [task, memory, other], errors: [{ path: "broken.ts", error: "failure" }], runtime: {} } as unknown as LoadExtensionsResult;
		const filtered = filterChildExtensions(base);
		assert.deepEqual(filtered.extensions, [memory, other]);
		assert.deepEqual(base.extensions, [task, memory, other]);
		assert.equal(filtered.errors, base.errors, "loading failures must not be hidden");
		assert.equal(filtered.runtime, base.runtime);
	}
});
