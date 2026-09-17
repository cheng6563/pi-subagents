import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, openSync, closeSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Contract, Depth } from "./contract.ts";
import { createRun, event, isTerminal, listRuns, lockResume, readContract, readRun, saveRun, type Run } from "./store.ts";
import { resolveHostPeerAliases } from "./runs/background/runner-aliases.ts";
import { CompletionDelivery } from "./delivery.ts";

export interface Notice { type: string; runId: string; [key: string]: unknown }
interface Live { child: ChildProcess; done: Promise<Run>; delivery: CompletionDelivery; stop: (status: "paused" | "cancelled", reason: string) => void }
export interface WorkerLaunch { run: Run; contract: Contract; resumeFile?: string; message?: string }

export function hostPackageRoot(): string {
	const configured = process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT;
	if (configured) return configured;
	let dir = dirname(realpathSync(process.argv[1]!));
	while (dir !== dirname(dir)) {
		const file = join(dir, "package.json");
		if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).name === "@earendil-works/pi-coding-agent") return dir;
		dir = dirname(dir);
	}
	throw new Error("Cannot locate the host Pi npm SDK. Standalone hosts are not supported by this executor");
}

export class RunController {
	readonly root: string;
	private readonly live = new Map<string, Live>();
	private readonly notify: (notice: Notice) => void;
	private closing = false;
	constructor(root: string, notify: (notice: Notice) => void = () => {}) { this.root = root; this.notify = notify; }

	// Includes startup and shutdown until the owned worker actually exits; no stale disk records.
	get activeCount(): number { return this.live.size; }

	list(): Run[] { return listRuns(this.root).map((run) => this.reconcile(run)); }
	status(id: string): Run { return this.reconcile(readRun(this.root, id)); }
	private reconcile(run: Run): Run {
		if (!isTerminal(run.status) && !this.live.has(run.id)) {
			// Never kill an unowned PID. A disconnected worker owns its shutdown; a stale record stays explicit.
			let alive = false;
			if (run.pid) { try { process.kill(run.pid, 0); alive = true; } catch {} }
			if (!alive) {
				run.status = "failed"; run.error = "Runner exited without a terminal result; inspect events/session before resume";
				saveRun(run); event(run, "reconciled_failure", { error: run.error });
			}
		}
		return run;
	}
	result(id: string): { run: Run; output: string } {
		const run = this.status(id);
		return { run, output: existsSync(run.outputPath) ? readFileSync(run.outputPath, "utf8") : "" };
	}

	async start(contract: Contract, options: { resumedFrom?: Run; message?: string; signal?: AbortSignal; notifyOnComplete?: boolean } = {}): Promise<Run> {
		options.signal?.throwIfAborted();
		if (this.closing) throw new Error("Executor is shutting down");
		const host = hostPackageRoot();
		const { aliases, missing } = resolveHostPeerAliases(host);
		if (missing.length) throw new Error(`Host Pi runtime dependencies are missing: ${missing.join(", ")}`);
		const run = createRun(this.root, contract, options.resumedFrom?.id);
		const stdout = openSync(join(run.dir, "runner.log"), "a");
		let child: ChildProcess;
		try {
			child = spawn(process.execPath, ["--import", new URL("../runner-peer-preload.mjs", import.meta.url).href, fileURLToPath(new URL("../runner.mjs", import.meta.url))], {
				cwd: contract.cwd, windowsHide: true,
				stdio: ["ignore", stdout, stdout, "ipc"],
				env: { ...process.env, JITI_ALIAS: JSON.stringify(aliases), PI_ASYNC_NATIVE_RUNNER: "1", PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: host, PI_SUBAGENT_CHILD: "1", PI_GENERIC_SUBAGENT: "1", PI_SUBAGENT_DEPTH: String(contract.depth.depth), PI_SUBAGENT_PARENT_SESSION: process.env.PI_SESSION_ID ?? "" },
			});
		} catch (error) {
			run.status = "failed"; run.error = String(error); saveRun(run); event(run, "spawn_failed", { error: run.error }); throw error;
		} finally { closeSync(stdout); }
		run.pid = child.pid; saveRun(run); event(run, "spawned", { pid: child.pid });
		let readyResolve!: (run: Run) => void;
		let readyReject!: (error: Error) => void;
		const ready = new Promise<Run>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
		let settled = false;
		let readySeen = false;
		const delivery = new CompletionDelivery(options.notifyOnComplete !== false);
		let forced: { status: "paused" | "cancelled"; reason: string } | undefined;
		let forceTimer: ReturnType<typeof setTimeout> | undefined;
		let deadline: ReturnType<typeof setTimeout> | undefined;
		let doneResolve!: (run: Run) => void;
		const done = new Promise<Run>((resolve) => { doneResolve = resolve; });
		const complete = (error?: string) => {
			if (settled) return; settled = true;
			if (deadline) clearTimeout(deadline); if (forceTimer) clearTimeout(forceTimer);
			options.signal?.removeEventListener("abort", onAbort);
			const current = readRun(this.root, run.id);
			if (!isTerminal(current.status)) {
				current.status = forced?.status ?? "failed";
				current.error = forced?.reason ?? error ?? "Runner exited without terminal status";
				saveRun(current); event(current, "runner_exit", { error: current.error, status: current.status });
			}
			this.live.delete(run.id);
			readyReject(new Error(`subagents ${run.id} ${current.status}: ${current.error ?? "exited before ready"}. Evidence: ${run.dir}`));
			doneResolve(current);
			// Before ready, the launch call itself receives the failure; there is no async handoff.
			if (readySeen) delivery.complete((channel) => {
				event(current, "completion_delivery", { channel });
				if (channel === "notice") this.notify({ type: "complete", runId: run.id, status: current.status, error: current.error, outputPath: current.outputPath, dir: current.dir });
			});
		};
		const stop = (status: "paused" | "cancelled", reason: string) => {
			if (settled || forced) return;
			forced = { status, reason };
			event(run, "control_requested", forced);
			if (child.connected) child.send({ type: "stop", status, reason }, () => {});
			forceTimer = setTimeout(() => { child.kill(); }, 7_000);
		};
		const onAbort = () => stop("paused", "Parent tool call interrupted");
		this.live.set(run.id, { child, done, delivery, stop });
		deadline = setTimeout(() => stop("paused", `Run timed out after ${contract.timeoutMs}ms`), contract.timeoutMs);
		child.on("message", (value) => {
			const message = value as Notice;
			if (message.type === "ready") { readySeen = true; readyResolve(readRun(this.root, run.id)); }
			else if (message.type === "notice") this.notify({ ...message, runId: run.id });
		});
		child.once("error", (error) => complete(error.message));
		child.once("exit", (code, signal) => complete(`Runner exited with code ${code}, signal ${signal}`));
		const resumeFile = options.resumedFrom?.sessionFile;
		child.send({ run, contract, ...(resumeFile ? { resumeFile } : {}), ...(options.message ? { message: options.message } : {}) } satisfies WorkerLaunch, (error) => { if (error) stop("paused", `Worker handoff failed: ${error.message}`); });
		if (options.resumedFrom) { options.resumedFrom.supersededBy = run.id; saveRun(options.resumedFrom); }
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) onAbort();
		return ready;
	}

	async resume(id: string, message: string | undefined, parentDepth?: Depth, signal?: AbortSignal, notifyOnComplete = true): Promise<Run> {
		const old = this.status(id);
		if (!isTerminal(old.status)) throw new Error(`Run ${id} is still active`);
		if (old.status === "cancelled") throw new Error("Cancelled runs cannot be resumed");
		if (old.supersededBy) throw new Error(`Run already resumed as ${old.supersededBy}; use the latest run ID`);
		const release = lockResume(old);
		try {
			const contract = readContract(old);
			if (parentDepth && (contract.depth.maxDepth > parentDepth.maxDepth || contract.depth.depth !== parentDepth.depth + 1)) throw new Error("Resume cannot expand or reset inherited depth");
			if (old.promptStarted && (!old.sessionFile || !existsSync(old.sessionFile))) throw new Error("Session missing after prompt started; refusing to replay the task. Inspect side effects before a new explicit run");
			return await this.start(contract, { signal, notifyOnComplete, resumedFrom: old, message: message ?? "Continue the remaining task using the saved session. Inspect prior progress and do not repeat completed side effects." });
		} finally { release(); }
	}
	async wait(id: string, signal?: AbortSignal): Promise<Run> {
		signal?.throwIfAborted();
		const live = this.live.get(id);
		if (!live) return this.status(id);
		const release = live.delivery.claim();
		try {
			const result = signal ? await new Promise<Run>((resolve, reject) => {
				const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(new Error("Wait interrupted; the async run is still managed. Use cancel/interrupt to stop it")); };
				signal.addEventListener("abort", onAbort, { once: true });
				live.done.then((run) => { signal.removeEventListener("abort", onAbort); resolve(run); }, reject);
			}) : await live.done;
			release(true);
			return result;
		} catch (error) { release(false); throw error; }
	}
	async cancel(id: string, pause = false): Promise<Run> {
		const live = this.live.get(id);
		if (!live) { const run = this.status(id); if (!isTerminal(run.status)) throw new Error("Runner is not owned by this session; refusing to signal an unverified PID"); return run; }
		live.stop(pause ? "paused" : "cancelled", pause ? "Interrupted by parent" : "Cancelled by parent");
		return live.done;
	}
	steer(id: string, message: string): void {
		const live = this.live.get(id);
		if (!live?.child.connected) throw new Error("Run is not active in this session");
		live.child.send({ type: "steer", message }, (error) => { if (error) this.notify({ type: "control_error", runId: id, error: error.message }); });
	}
	async drain(): Promise<void> { while (this.live.size) await Promise.all([...this.live.values()].map((run) => run.done)); }
	async shutdown(): Promise<void> {
		this.closing = true;
		for (const live of this.live.values()) live.stop("paused", "Parent session closed or reloaded");
		await this.drain();
	}
}
