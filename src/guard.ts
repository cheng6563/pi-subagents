import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const agentLaunch = /(?:^|[\s;&|("'`/\\])(?:pi(?:\.exe|\.cmd|\.bat)?|claude(?:\.exe|\.cmd)?|codex(?:\.exe|\.cmd)?|cursor-agent|opencode)(?=$|[\s;|&"'`])|createAgentSession\s*\(|pi-coding-agent[/\\](?:dist[/\\])?(?:cli|main)|pi-subagents[/\\].*(?:runner|index)|\b(?:PI_SUBAGENT_CHILD|PI_GENERIC_SUBAGENT|PI_SUBAGENT_DEPTH)\s*=/i;
const scriptPath = /(?:"([^"\r\n]+\.(?:py|pyw|js|mjs|cjs|ts|sh|bash|ps1|cmd|bat))"|'([^'\r\n]+\.(?:py|pyw|js|mjs|cjs|ts|sh|bash|ps1|cmd|bat))'|([^\s"'`;|&<>]+\.(?:py|pyw|js|mjs|cjs|ts|sh|bash|ps1|cmd|bat)))(?=$|[\s"'`;|&)])/gi;

/** Operational guard, not an OS sandbox: inspect direct commands and referenced local scripts. */
export function commandBlockReason(command: string, cwd: string, seen = new Set<string>()): string | undefined {
	if (agentLaunch.test(command)) return "Agent launch outside subagent is forbidden; use the executor's inherited depth budget";
	if (seen.size > 32) return "Cannot verify script delegation boundary: reference limit exceeded";
	for (const match of command.matchAll(new RegExp(scriptPath))) {
		const file = resolve(cwd, match[1] ?? match[2] ?? match[3]!);
		if (seen.has(file)) continue;
		seen.add(file);
		if (!existsSync(file)) continue;
		try {
			if (!statSync(file).isFile()) continue;
			const text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(file));
			const blocked = commandBlockReason(text, cwd, seen);
			if (blocked) return `${blocked} (script: ${file})`;
		} catch (error) {
			return `Cannot inspect script '${file}': ${error instanceof Error ? error.message : String(error)}`;
		}
	}
	const npm = /\b(?:npm|pnpm|yarn)(?:\.cmd)?\s+(?:run\s+)?([\w:-]+)/.exec(command);
	if (npm && !["install", "ci", "add", "remove", "list", "ls", "view", "info", "--version"].includes(npm[1]!)) {
		const file = resolve(cwd, "package.json");
		const key = `${file}#${npm[1]}`;
		if (existsSync(file) && !seen.has(key)) {
			seen.add(key);
			try {
				const scripts = JSON.parse(readFileSync(file, "utf8")).scripts ?? {};
				for (const name of [`pre${npm[1]}`, npm[1]!, `post${npm[1]}`]) {
					if (typeof scripts[name] === "string") {
						const reason = commandBlockReason(scripts[name], cwd, seen);
						if (reason) return `${reason} (package script: ${name})`;
					}
				}
			} catch (error) { return `Cannot inspect package scripts: ${String(error)}`; }
		}
	}
	return undefined;
}

export function toolCommandBlockReason(toolName: string, input: unknown, cwd: string): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const value = input as Record<string, unknown>;
	// Also cover remote shell tools and MCP shell wrappers with command/script fields.
	for (const name of ["command", "script", "code"]) {
		if (typeof value[name] === "string") {
			const reason = commandBlockReason(value[name], cwd);
			if (reason) return `${toolName}: ${reason}`;
		}
	}
	return undefined;
}
