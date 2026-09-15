import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { StringEnum } from "@earendil-works/pi-ai";

const launchOptionsSchema = Type.Object({
	requirementsFile: Type.Optional(Type.String({ minLength: 1, description: "UTF-8 .md file, relative to caller cwd; read before launch and saved for resume." })),
	model: Type.Optional(Type.String({ minLength: 1, description: "Default: exact parent model. Use shared:lowCost or provider/model[:thinking]; unavailable selections fail without fallback." })),
	maxDepth: Type.Optional(Type.Integer({ minimum: 1, description: "Absolute tree depth ceiling, root default 1. Descendants inherit it and cannot increase it." })),
	context: Type.Optional(StringEnum(["fresh", "fork"] as const, { description: "Default fresh: no parent history/system prompt. fork copies parent conversation only. Normal environment resources still load." })),
	cwd: Type.Optional(Type.String({ minLength: 1, description: "Child working directory; default caller cwd." })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Run timeout; default 30 minutes." })),
}, { additionalProperties: false });

export type LaunchOptions = Static<typeof launchOptionsSchema>;

export const parameters = Type.Object({
	action: Type.Optional(StringEnum(["status", "list", "result", "wait", "cancel", "interrupt", "resume", "steer", "report"] as const, { description: "Omit to launch. list/status inspect runs; result reads output. wait consumes completion without another notice; aborting wait leaves the run active and restores async notification. interrupt pauses and permits resume; cancel terminates and cannot be resumed. resume continues the saved run under a new ID. steer sends instructions; report sends a message to the parent." })),
	task: Type.Optional(Type.String({ minLength: 1, description: "Task for a new generic child. Omit action to launch." })),
	// An open configuration object preserves optional fields on Responses transports
	// that otherwise implicitly constrain closed schemas. Execution validates its exact keys/types.
	options: Type.Optional(Type.Unsafe<LaunchOptions>({
		type: "object",
		properties: launchOptionsSchema.properties,
		additionalProperties: true,
		description: "Optional launch settings: requirementsFile, model, maxDepth, context, cwd, timeoutMs. Omit for defaults. Runtime rejects other keys/types. Not accepted by management/resume actions.",
	})),
	async: Type.Optional(Type.Boolean({ description: "Default true: return a run ID and notify the parent on completion. false waits and returns the result without an extra completion notice. Also valid for resume." })),
	id: Type.Optional(Type.String({ minLength: 1, description: "Exact run UUID for status/control/recovery." })),
	message: Type.Optional(Type.String({ minLength: 1, description: "Resume/steer message or a child report to its parent." })),
}, { additionalProperties: false });

export type Params = Static<typeof parameters>;

export function validateParams(value: unknown): Params {
	if (!Check(parameters, value)) throw new Error("Invalid subagent parameters. Use task and optional options for launch; action/id/message for management; async is available for both.");
	if (value.options !== undefined && !Check(launchOptionsSchema, value.options)) {
		throw new Error("Invalid options. Supported keys/types: requirementsFile/string, model/string, maxDepth/integer >= 1, context/fresh|fork, cwd/string, timeoutMs/integer >= 1.");
	}
	return value;
}
