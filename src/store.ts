import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync, openSync, closeSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { validateContract, type Contract } from "./contract.ts";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "paused" | "cancelled";
export interface Run {
	version: 1;
	id: string;
	dir: string;
	status: RunStatus;
	createdAt: string;
	updatedAt: string;
	pid?: number;
	sessionFile?: string;
	promptStarted?: boolean;
	error?: string;
	resumedFrom?: string;
	supersededBy?: string;
	outputPath: string;
	usage?: unknown;
}
export function storeRoot(sessionId: string): string {
	return join(process.env.LOCALAPPDATA || tmpdir(), "PiSubagents", sessionId.replace(/[^a-zA-Z0-9_-]/g, "_"));
}
export function writeJson(file: string, value: unknown): void {
	mkdirSync(resolve(file, ".."), { recursive: true });
	const temp = `${file}.${randomUUID()}.tmp`;
	writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(temp, file);
}
export function saveRun(run: Run): void {
	run.updatedAt = new Date().toISOString();
	writeJson(join(run.dir, "status.json"), run);
}
export function event(run: Run, type: string, data: unknown = {}): void {
	appendFileSync(join(run.dir, "events.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), runId: run.id, type, data })}\n`, "utf8");
}
export function createRun(root: string, contract: Contract, resumedFrom?: string): Run {
	const id = randomUUID();
	const dir = join(root, id);
	mkdirSync(dir, { recursive: true });
	const at = new Date().toISOString();
	const run: Run = { version: 1, id, dir, status: "queued", createdAt: at, updatedAt: at, outputPath: join(dir, "output.md"), ...(resumedFrom ? { resumedFrom } : {}) };
	writeJson(join(dir, "contract.json"), contract);
	saveRun(run);
	event(run, "prepared", { model: contract.model, depth: contract.depth, context: contract.context, requirements: contract.requirements ? { path: contract.requirements.path, sha256: contract.requirements.sha256 } : null });
	return run;
}
export function readRun(root: string, id: string): Run {
	if (!/^[\da-f-]{36}$/i.test(id)) throw new Error("An exact generic run UUID is required");
	const dir = join(root, id);
	const value = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as Run;
	if (value.version !== 1 || value.id !== id || resolve(value.dir) !== resolve(dir)) throw new Error("Invalid run metadata");
	return value;
}
export function readContract(run: Run): Contract {
	return validateContract(JSON.parse(readFileSync(join(run.dir, "contract.json"), "utf8")));
}
export function listRuns(root: string): Run[] {
	if (!existsSync(root)) return [];
	return readdirSync(root).filter((id) => /^[\da-f-]{36}$/i.test(id)).map((id) => readRun(root, id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function isTerminal(status: RunStatus): boolean { return status !== "queued" && status !== "running"; }
export function lockResume(run: Run): () => void {
	const file = join(run.dir, "resume.lock");
	let fd: number;
	try { fd = openSync(file, "wx"); }
	catch { throw new Error(`Run ${run.id} is already being resumed; inspect resume.lock before recovery`); }
	writeFileSync(fd, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`, "utf8");
	closeSync(fd);
	return () => unlinkSync(file);
}
