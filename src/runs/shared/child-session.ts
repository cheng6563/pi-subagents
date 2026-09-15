/** SDK session adapter, retained from the original runtime and reduced to session lifecycle. */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { pinChildCacheRetention } from "../../shared/child-cache-retention.ts";
import { getAgentDir } from "../../shared/utils.ts";
import type { ModelSelection } from "../../contract.ts";

export type PiCodingAgentModule = typeof import("@earendil-works/pi-coding-agent");
export interface ChildSessionEvent { type: string; [key: string]: unknown }
export interface ChildSession {
	subscribe(listener: (event: ChildSessionEvent) => void): () => void;
	prompt(text: string): Promise<void>;
	steer(text: string): Promise<void>;
	abort(): Promise<void>;
	dispose(): Promise<void>;
	readonly messages: readonly AgentMessage[];
	readonly sessionFile: string | undefined;
	readonly modelId: string | undefined;
}
export interface ChildSessionLaunch {
	cwd: string;
	sessionDir: string;
	resumeFile?: string;
	model: ModelSelection;
	contextMessages?: AgentMessage[];
	appendSystemPrompt: string;
	hooks: { name: string; factory: (pi: ExtensionAPI) => void }[];
	onExtensionError(error: { extensionPath: string; event: string; error: unknown }): void;
}

export function projectChildSessionEventForJson(event: ChildSessionEvent): unknown {
	if (event.type !== "message_update") return event;
	const update = event.assistantMessageEvent as Record<string, unknown> | undefined;
	if (!update) return event;
	const { partial: _partial, ...delta } = update;
	return { type: event.type, assistantMessageEvent: delta };
}

export function createDefaultChildSessionFactory(options: { loadPiCodingAgent?: () => Promise<PiCodingAgentModule>; shutdownTimeoutMs?: number } = {}) {
	const loadPi = options.loadPiCodingAgent ?? (() => import("@earendil-works/pi-coding-agent"));
	return {
		async create(launch: ChildSessionLaunch): Promise<ChildSession> {
			const pi = await loadPi();
			const modelRuntime = await pi.ModelRuntime.create();
			const settingsManager = pi.SettingsManager.create(launch.cwd, getAgentDir());
			const themeKey = Symbol.for("@earendil-works/pi-coding-agent:theme");
			if (!(globalThis as Record<symbol, unknown>)[themeKey] && typeof pi.initTheme === "function") pi.initTheme(settingsManager.getTheme());
			const loader = new pi.DefaultResourceLoader({
				cwd: launch.cwd, agentDir: getAgentDir(), settingsManager,
				// Normal environment tools, extensions, skills and AGENTS.md remain available.
				noPromptTemplates: true, noThemes: true,
				appendSystemPrompt: [launch.appendSystemPrompt],
				extensionFactories: launch.hooks,
			});
			await loader.reload();
			const loaded = loader.getExtensions();
			if (loaded.errors.length) throw new Error(`Child extension loading failed: ${loaded.errors.map(({ path, error }) => `${path}: ${error}`).join("; ")}`);
			// Preserve the host runtime's provider registration path before selecting the exact model.
			for (const { name, config } of loaded.runtime.pendingProviderRegistrations ?? []) modelRuntime.registerProvider(name, config);
			for (const { provider } of loaded.runtime.pendingNativeProviderRegistrations ?? []) modelRuntime.registerNativeProvider(provider);
			loaded.runtime.pendingProviderRegistrations = [];
			loaded.runtime.pendingNativeProviderRegistrations = [];
			await modelRuntime.refresh({ allowNetwork: false });
			const available = await modelRuntime.getAvailable();
			const selected = available.find((m) => m.provider === launch.model.provider && m.id === launch.model.id);
			if (!selected) throw new Error(`Selected model '${launch.model.provider}/${launch.model.id}' is unavailable in child runtime; no fallback is allowed`);
			if (launch.resumeFile && !existsSync(launch.resumeFile)) throw new Error(`Resume session is missing: ${launch.resumeFile}`);
			const sessionManager = launch.resumeFile
				? pi.SessionManager.forkFrom(launch.resumeFile, launch.cwd, launch.sessionDir)
				: pi.SessionManager.create(launch.cwd, launch.sessionDir);
			if (!launch.resumeFile) for (const message of launch.contextMessages ?? []) {
				if (message.role === "branchSummary" || message.role === "compactionSummary") sessionManager.appendCustomMessageEntry("inherited-conversation-summary", message.summary, false);
				else sessionManager.appendMessage(message);
			}
			const { session, modelFallbackMessage } = await pi.createAgentSession({
				cwd: launch.cwd, agentDir: getAgentDir(), modelRuntime, model: selected,
				thinkingLevel: launch.model.thinking, resourceLoader: loader, sessionManager, settingsManager,
				sessionStartEvent: { type: "session_start", reason: "startup" },
			});
			if (modelFallbackMessage || session.model?.provider !== selected.provider || session.model?.id !== selected.id) {
				session.dispose();
				throw new Error(`Child model verification failed: ${modelFallbackMessage ?? "model changed during creation"}`);
			}
			pinChildCacheRetention(session.agent);
			try {
				await session.bindExtensions({ mode: "print", onError: (error) => launch.onExtensionError({ extensionPath: error.extensionPath, event: error.event, error: error.error }) });
			} catch (error) { session.dispose(); throw error; }
			let pending: Promise<void> | undefined;
			return {
				subscribe: (listener) => session.subscribe((event) => listener(event as unknown as ChildSessionEvent)),
				prompt: (text) => session.prompt(text, { expandPromptTemplates: false }),
				steer: (text) => session.steer(text),
				abort: () => session.abort(),
				dispose() {
					pending ??= (async () => {
						let timer: ReturnType<typeof setTimeout> | undefined;
						try {
							const shutdown = session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
							await Promise.race([shutdown, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Child extension shutdown timed out")), options.shutdownTimeoutMs ?? 5_000); })]);
						} finally { if (timer) clearTimeout(timer); session.dispose(); }
					})();
					return pending;
				},
				get messages() { return session.messages; },
				get sessionFile() { return session.sessionFile; },
				get modelId() { return session.model ? `${session.model.provider}/${session.model.id}` : undefined; },
			};
		},
	};
}
