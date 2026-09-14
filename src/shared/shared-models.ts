import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { splitKnownThinkingSuffix } from "./model-info.ts";
import { getAgentDir } from "./utils.ts";

const SharedModels = Type.Record(Type.String(), Type.Object({
	provider: Type.String({ pattern: "\\S" }),
	model: Type.String({ pattern: "\\S" }),
}));
const PREFIX = "shared:";

/** Expand only explicit shared references; ordinary model selection does no configuration I/O. */
export function resolveSharedModelReference(model: string): string {
	if (!model.startsWith(PREFIX)) return model;
	const file = join(getAgentDir(), "shared-models.json");
	let saved: unknown;
	try {
		saved = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(`Cannot resolve '${model}': unable to read ${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!Check(SharedModels, saved)) {
		throw new Error(`Invalid shared model configuration in ${file}: each entry requires provider and model strings.`);
	}
	const reference = model.slice(PREFIX.length);
	// A literal configuration key wins over interpreting its final segment as thinking.
	const { baseModel: name, thinkingSuffix } = Object.hasOwn(saved, reference)
		? { baseModel: reference, thinkingSuffix: "" }
		: splitKnownThinkingSuffix(reference);
	if (!name || !Object.hasOwn(saved, name)) {
		throw new Error(`Unknown shared model '${reference}' in ${file}. Configure it before launching a subagent.`);
	}
	const selected = saved[name]!;
	return `${selected.provider.trim()}/${selected.model.trim()}${thinkingSuffix}`;
}
