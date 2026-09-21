import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { StringEnum } from "@earendil-works/pi-ai";

const launchOptionsSchema = Type.Object({
	requirementsFile: Type.Optional(Type.String({ minLength: 1, description: "UTF-8 .md task requirements; snapshotted at launch." })),
	model: Type.Optional(Type.String({ minLength: 1, description: "Default: parent model. Override: shared:lowCost or provider/model[:thinking]." })),
	maxDepth: Type.Optional(Type.Integer({ minimum: 1, description: "Absolute depth ceiling; default 1." })),
	context: Type.Optional(StringEnum(["fresh", "fork"] as const, { description: "Default fresh; fork copies parent conversation." })),
	cwd: Type.Optional(Type.String({ minLength: 1, description: "Default: caller cwd." })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Default: 1800000 ms." })),
}, { additionalProperties: false });

export type LaunchOptions = Static<typeof launchOptionsSchema>;

export const parameters = Type.Object({
	action: Type.Optional(StringEnum(["status", "list", "result", "wait", "cancel", "interrupt", "resume", "steer", "report"] as const, { description: "Omit to launch. interrupt pauses (resumable); cancel terminates (final); resume returns a new ID." })),
	task: Type.Optional(Type.String({ minLength: 1, description: "New task; begin with action, target and goal, then context and constraints." })),
	// An open configuration object preserves optional fields on Responses transports
	// that otherwise implicitly constrain closed schemas. Execution validates its exact keys/types.
	options: Type.Optional(Type.Unsafe<LaunchOptions>({
		type: "object",
		properties: launchOptionsSchema.properties,
		additionalProperties: true,
		description: "Launch only; omit for defaults.",
	})),
	async: Type.Optional(Type.Boolean({ description: "Default true: notify on completion. false: wait, no extra notice. Launch/resume only." })),
	id: Type.Optional(Type.String({ minLength: 1, description: "Full run UUID." })),
	message: Type.Optional(Type.String({ minLength: 1, description: "Resume/steer instructions or report to parent." })),
}, { additionalProperties: false });

export type Params = Static<typeof parameters>;

export function validateParams(value: unknown): Params {
	if (!Check(parameters, value)) throw new Error("Invalid subagent parameters. Use task and optional options for launch; action/id/message for management; async is available for both.");
	if (value.options !== undefined && !Check(launchOptionsSchema, value.options)) {
		throw new Error("Invalid options. Supported keys/types: requirementsFile/string, model/string, maxDepth/integer >= 1, context/fresh|fork, cwd/string, timeoutMs/integer >= 1.");
	}
	return value;
}
