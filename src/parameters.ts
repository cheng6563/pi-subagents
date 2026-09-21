import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { StringEnum } from "@earendil-works/pi-ai";

const launchOptionsSchema = Type.Object({
	requirementsFile: Type.Optional(Type.String({ minLength: 1, description: "UTF-8 .md requirements, relative to caller cwd; loaded at launch, snapshot reused on resume." })),
	model: Type.Optional(Type.String({ minLength: 1, description: "Default: exact parent model/thinking. Override: shared:lowCost or provider/model[:thinking]; unavailable choices fail, no fallback." })),
	maxDepth: Type.Optional(Type.Integer({ minimum: 1, description: "Absolute depth ceiling; root default 1. Children inherit/cannot increase it; subagent is unavailable at the ceiling." })),
	context: Type.Optional(StringEnum(["fresh", "fork"] as const, { description: "Default fresh: no parent history/system prompt. fork copies parent conversation only." })),
	cwd: Type.Optional(Type.String({ minLength: 1, description: "Default: caller cwd." })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Default: 1800000 ms." })),
}, { additionalProperties: false });

export type LaunchOptions = Static<typeof launchOptionsSchema>;

export const parameters = Type.Object({
	action: Type.Optional(StringEnum(["status", "list", "result", "wait", "cancel", "interrupt", "resume", "steer", "report"] as const, { description: "Omit to launch (task required). list/status inspect; result reads output; wait awaits completion (aborting wait does not stop the run). interrupt pauses (resumable); cancel terminates (final). resume keeps original requirements, model, depth, cwd and context, returning a new ID. steer sends instructions; report sends a message to parent." })),
	task: Type.Optional(Type.String({ minLength: 1, description: "New task; begin with action, target and goal, then context and constraints." })),
	// An open configuration object preserves optional fields on Responses transports
	// that otherwise implicitly constrain closed schemas. Execution validates its exact keys/types.
	options: Type.Optional(Type.Unsafe<LaunchOptions>({
		type: "object",
		properties: launchOptionsSchema.properties,
		additionalProperties: true,
		description: "Launch only; omit for defaults. Management/resume rejects task and options; only listed option keys are accepted.",
	})),
	async: Type.Optional(Type.Boolean({ description: "Default true: return ID, notify on completion. false: wait, no extra notice. Launch/resume only. wait receives completion instead of a notification; aborting wait restores async notification." })),
	id: Type.Optional(Type.String({ minLength: 1, description: "Full run UUID; required for management except list/report." })),
	message: Type.Optional(Type.String({ minLength: 1, description: "Required for steer/report; optional remaining-work instructions for resume. report is child-only." })),
}, { additionalProperties: false });

export type Params = Static<typeof parameters>;

export function validateParams(value: unknown): Params {
	if (!Check(parameters, value)) throw new Error("Invalid subagent parameters. Use task and optional options for launch; action/id/message for management; async is available for both.");
	if (value.options !== undefined && !Check(launchOptionsSchema, value.options)) {
		throw new Error("Invalid options. Supported keys/types: requirementsFile/string, model/string, maxDepth/integer >= 1, context/fresh|fork, cwd/string, timeoutMs/integer >= 1.");
	}
	return value;
}
