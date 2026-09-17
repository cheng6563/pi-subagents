import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";

/** Parent-owned coordination and persistent-memory mutations are not child capabilities. */
export const CHILD_EXCLUDED_TOOLS = [
	"task_list", "task_add", "question", "scratchpad",
	"memory_write", "memory_forget", "memory_restore",
];

/** Hiding task tools alone would leave its watchdog, prompt injection and compaction hooks running. */
export function filterChildExtensions(base: LoadExtensionsResult): LoadExtensionsResult {
	return {
		...base,
		extensions: base.extensions.filter((extension) =>
			!extension.resolvedPath.replaceAll("\\", "/").endsWith("/task-list/index.ts")),
	};
}
