import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunController } from "../src/controller.ts";

assert.ok(process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT, "Host SDK root is required");
const root = mkdtempSync(join(tmpdir(), "generic-subagent-startup-cancel-"));
const controller = new RunController(root);
const abort = new AbortController();
try {
  const launched = controller.start({ version: 1, task: "Must never run", cwd: root, model: { provider: "absent", id: "must-not-resolve", thinking: "off" }, context: "fresh", depth: { depth: 1, maxDepth: 1 }, timeoutMs: 30000 }, { signal: abort.signal });
  const before = controller.list()[0]!;
  assert.ok(before.pid, "Cancel after a real worker PID was allocated");
  abort.abort();
  await assert.rejects(() => launched, /paused.*interrupted/);
  const after = await controller.wait(before.id);
  assert.equal(after.status, "paused");
  assert.equal(after.promptStarted, undefined);
  assert.equal(after.sessionFile, undefined);
  writeFileSync(join(root, "result.json"), JSON.stringify(after, null, 2), "utf8");
  console.log(`STARTUP_CANCEL_PASS ${root}`);
} finally { await controller.shutdown(); }
