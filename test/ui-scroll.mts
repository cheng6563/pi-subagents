import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { resolveHostPeerAliases } from "../src/runs/background/runner-aliases.ts";
import { createRun, saveRun, storeRoot, writeJson } from "../src/store.ts";
import { emptyProgress } from "../src/progress.ts";

const host = process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT;
assert.ok(host);
const { aliases } = resolveHostPeerAliases(host);
const jiti = createJiti(import.meta.url, { alias: aliases });
const sdk = await jiti.import<any>("@earendil-works/pi-coding-agent");
const tui = await jiti.import<any>("@earendil-works/pi-tui");
const { createRunResultRenderer } = await jiti.import<any>("../src/ui.ts");
const { KeybindingsManager } = await jiti.import<any>(join(host, "dist/core/keybindings.js"));
tui.setKeybindings(new KeybindingsManager());
sdk.initTheme("dark");
const { getThemeByName } = await jiti.import<any>(join(host, "dist/modes/interactive/theme/theme.js"));
const theme = getThemeByName("dark");
const root = mkdtempSync(join(tmpdir(), "subagents-scroll-"));
process.env.LOCALAPPDATA = root;
const session = sdk.SessionManager.create(root, join(root, "sessions"));
const run = createRun(storeRoot(session.getSessionId()), { version: 1, task: "SCROLL_PROBE", cwd: root, model: { provider: "fixture", id: "parent", thinking: "off" }, context: "fresh", depth: { depth: 1, maxDepth: 1 }, timeoutMs: 60000 });
run.status = "running"; run.pid = process.pid; saveRun(run);
const initialRun = structuredClone(run);
writeJson(join(run.dir, "progress.json"), { ...emptyProgress(), text: "PREVIEW" });
const renderer = createRunResultRenderer();
const card = renderer({ details: initialRun }, { expanded: false }, theme);
const originalNow = Date.now;
let now = originalNow();
Date.now = () => now;
let writes: string[] = [];
const terminal = { columns: 80, rows: 24, kittyProtocolActive: false, start() {}, stop() {}, async drainInput() {}, write(data: string) { writes.push(data); }, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {} };
const screen = new tui.TuiMainScreen(terminal);
try {
  screen.addChild(card);
  screen.addChild(new tui.Text(Array.from({ length: 160 }, (_, i) => `HISTORY_${String(i).padStart(3, "0")}`).join("\n"), 0, 0));
  screen.addChild(new tui.Text("EDITOR", 0, 0));
  screen.start(); screen.renderNow();
  const heights: number[] = [];
  for (const text of ["", "short", "x".repeat(4000), "a\nb\nc\nd\ne", "中文".repeat(1000)]) {
    writeJson(join(run.dir, "progress.json"), { ...emptyProgress(), text });
    const component = renderer({ details: initialRun }, { expanded: false, isPartial: true }, theme);
    heights.push(component.render(80).length);
  }
  writes = []; now += 1500; screen.renderNow();
  const runningClears = writes.join("").includes("\x1b[3J");
  run.status = "completed"; saveRun(run);
  writeFileSync(run.outputPath, "FINAL_SCROLL_RESULT", "utf8");
  writeJson(join(run.dir, "progress.json"), { ...emptyProgress(), activity: "completed", text: "FINAL_SCROLL_RESULT" });
  screen.renderNow();
  writes = []; now += 1500; screen.renderNow();
  const completedClears = writes.join("").includes("\x1b[3J");
  const result = { heights, runningClearsScrollback: runningClears, completedClearsScrollback: completedClears };
  writeFileSync(join(root, "results.json"), JSON.stringify(result, null, 2), "utf8");
  console.log(JSON.stringify(result));
  if (!process.argv.includes("--probe")) {
    assert.equal(new Set(heights).size, 1, "Running history card height must not depend on progress text");
    assert.equal(runningClears, false, "Updating progress must not rewrite offscreen history");
    assert.equal(completedClears, false, "Completed history must stay frozen across subsequent refreshes");
    assert.match(card.render(80).join("\n"), /FINAL_SCROLL_RESULT/, "The original async launch card should update once on completion");
  }
  console.log(`SCROLL_EVIDENCE ${root}`);
} finally { Date.now = originalNow; screen.stop(); }

// Persist display fixtures for a separate actual Pi process; no model task is executed.
run.status = "running"; saveRun(run);
writeJson(join(run.dir, "progress.json"), { ...emptyProgress(), activity: "输出中", text: "LIVE_INITIAL" });
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (content: any[], stopReason = "stop") => ({ role: "assistant", content, api: "openai-completions", provider: "fixture", model: "parent", usage, stopReason, timestamp: Date.now() });
session.appendMessage(assistant([{ type: "text", text: "```text\n" + Array.from({ length: 100 }, (_, i) => `BEFORE_${String(i).padStart(3, "0")}`).join("\n") + "\n```" }]));
session.appendMessage(assistant([{ type: "toolCall", id: "live-fixture-call", name: "subagent", arguments: { task: "SCROLL_PROBE", async: true } }], "toolUse"));
session.appendMessage({ role: "toolResult", toolCallId: "live-fixture-call", toolName: "subagent", content: [{ type: "text", text: JSON.stringify(initialRun) }], details: initialRun, isError: false, timestamp: Date.now() });
session.appendMessage(assistant([{ type: "text", text: "```text\n" + Array.from({ length: 200 }, (_, i) => `HISTORY_${String(i).padStart(3, "0")}`).join("\n") + "\n```" }]));
const agentDir = join(root, "agent"); mkdirSync(agentDir);
writeJson(join(agentDir, "settings.json"), { quietStartup: true, defaultProvider: "fixture", defaultModel: "parent" });
writeJson(join(agentDir, "models.json"), { providers: { fixture: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "fixture", models: [{ id: "parent", name: "UI Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } });
writeJson(join(root, "fixture.json"), { root, agentDir, session: session.getSessionFile(), activeRun: join(run.dir, "status.json"), output: run.outputPath, progress: join(run.dir, "progress.json"), extension: fileURLToPath(new URL("../index.ts", import.meta.url)), cli: join(host, "dist/cli.js") });
console.log(`LIVE_PTY_FIXTURE ${join(root, "fixture.json")}`);
