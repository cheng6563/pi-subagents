import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requirementsPrompt, validateContract } from "./contract.ts";
import { event, saveRun, type RunStatus } from "./store.ts";
import { registerExecutor } from "./extension.ts";
import { progressWriter } from "./progress.ts";
import type { RunController, WorkerLaunch } from "./controller.ts";
import { createDefaultChildSessionFactory, projectChildSessionEventForJson, type ChildSession } from "./runs/shared/child-session.ts";

function send(value: unknown): void { if (process.connected) process.send?.(value as object, () => {}); }

export async function runWorker(input: WorkerLaunch, pendingControls: unknown[] = []): Promise<void> {
	const { run } = input;
	const contract = validateContract(input.contract);
	const progress = progressWriter(run);
	let session: ChildSession | undefined;
	let children: RunController | undefined;
	let stopped: { status: "paused" | "cancelled"; reason: string } | undefined;
	let extensionError: string | undefined;
	const throwIfStopped = () => { if (stopped) throw new Error(stopped.reason); };
	const stop = (status: "paused" | "cancelled", reason: string) => {
		stopped ??= { status, reason };
		void session?.abort().catch((error) => event(run, "abort_failed", { error: String(error) }));
		void children?.shutdown().catch((error) => event(run, "children_shutdown_failed", { error: String(error) }));
	};
	const onMessage = (input: unknown) => {
		const m = input as { type: string; status?: "paused" | "cancelled"; reason?: string; message?: string };
		if (m.type === "stop") stop(m.status === "cancelled" ? "cancelled" : "paused", m.reason ?? "Interrupted");
		if (m.type === "steer" && m.message && session) void session.steer(m.message).catch((error) => { event(run, "steer_failed", { error: String(error) }); send({ type: "notice", error: String(error) }); });
	};
	const onDisconnect = () => stop("paused", "Parent process disconnected");
	process.on("message", onMessage);
	process.on("disconnect", onDisconnect);
	const onSignal = () => stop("paused", "Runner received termination signal");
	process.on("SIGTERM", onSignal); process.on("SIGINT", onSignal);
	for (const control of pendingControls) onMessage(control);
	if (!process.connected) onDisconnect();
	let finalStatus: RunStatus = "failed";
	let finalError: string | undefined;
	try {
		throwIfStopped();
		mkdirSync(join(run.dir, "session"), { recursive: true });
		session = await createDefaultChildSessionFactory().create({
			cwd: contract.cwd, sessionDir: join(run.dir, "session"), resumeFile: input.resumeFile,
			model: contract.model, contextMessages: contract.contextMessages,
			appendSystemPrompt: requirementsPrompt(contract),
			hooks: [{ name: "generic-subagent-runtime", factory: (pi) => registerExecutor(pi, {
				depth: contract.depth, root: join(run.dir, "children"),
				onController: (controller) => { children = controller; },
				report: (message) => { event(run, "child_report", { message }); send({ type: "notice", message }); },
			}) }],
			onToolPolicyApplied: (policy) => event(run, "child_tool_policy_applied", policy),
			onExtensionError: (error) => {
				extensionError = `${error.extensionPath} (${error.event}): ${String(error.error)}`;
				event(run, "extension_error", { error: extensionError });
				void session?.abort().catch(() => {});
			},
		});
		if (extensionError) throw new Error(extensionError);
		run.sessionFile = session.sessionFile;
		run.status = "running";
		saveRun(run);
		event(run, "session_ready", { sessionFile: run.sessionFile, model: session.modelId, depth: contract.depth });
		session.subscribe((e) => {
			progress.update(e);
			event(run, "session_event", projectChildSessionEventForJson(e));
			if (session?.sessionFile && run.sessionFile !== session.sessionFile) { run.sessionFile = session.sessionFile; saveRun(run); }
		});
		throwIfStopped();
		const prompt = input.resumeFile ? input.message ?? "Continue the remaining task." : `${contract.task}${input.message ? `\n\n${input.message}` : ""}`;
		run.promptStarted = true; saveRun(run);
		send({ type: "ready" });
		await session.prompt(prompt);
		throwIfStopped();
		if (extensionError) throw new Error(extensionError);
		await children?.drain();
		throwIfStopped();
		const terminal = [...session.messages].reverse().find((m) => m.role === "assistant");
		if (!terminal || terminal.role !== "assistant") throw new Error("Child ended without an assistant response");
		if (terminal.stopReason === "error" || terminal.stopReason === "aborted") throw new Error(terminal.errorMessage || `Child model ended with ${terminal.stopReason}`);
		finalStatus = "completed";
	} catch (error) {
		finalStatus = stopped?.status ?? "failed";
		finalError = stopped?.reason ?? (error instanceof Error ? error.message : String(error));
		event(run, "execution_failed", { status: finalStatus, error: finalError });
	} finally {
		if (session) {
			const messages = session.messages;
			const last = [...messages].reverse().find((m) => m.role === "assistant");
			const output = last?.role === "assistant" ? last.content.filter((p) => p.type === "text").map((p) => p.text).join("\n") : "";
			writeFileSync(run.outputPath, output, "utf8");
			run.sessionFile = session.sessionFile;
			run.usage = messages.filter((m) => m.role === "assistant").map((m) => m.usage);
			try { await session.dispose(); }
			catch (error) { finalStatus = stopped?.status ?? "failed"; finalError = `${finalError ? `${finalError}; ` : ""}Shutdown failed: ${String(error)}`; }
		}
		await children?.shutdown();
		run.status = finalStatus; run.error = finalError; saveRun(run);
		progress.finish(finalStatus);
		event(run, "terminal", { status: finalStatus, error: finalError, outputPath: run.outputPath });
		process.off("message", onMessage); process.off("disconnect", onDisconnect);
		process.off("SIGTERM", onSignal); process.off("SIGINT", onSignal);
	}
}
