import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { StringEnum } from "@earendil-works/pi-ai";

const launchOptionProperties = {
	requirementsFile: Type.Optional(Type.String({ minLength: 1, description: "Requirements markdown, relative to caller cwd." })),
	model: Type.Optional(Type.String({ minLength: 1, description: "Default: parent model. shared:lowCost or provider/model[:thinking]." })),
	maxDepth: Type.Optional(Type.Integer({ minimum: 1, description: "Depth ceiling. Default 1." })),
	context: Type.Optional(StringEnum(["fresh", "fork"] as const, { description: "Default fresh. fork copies the parent conversation." })),
	cwd: Type.Optional(Type.String({ minLength: 1, description: "Default: caller cwd." })),
};

// Hidden from the model-facing schema for now; keep the runtime option for compatibility.
const launchOptionsSchema = Type.Object(launchOptionProperties, { additionalProperties: false });
const launchOptionsValidationSchema = Type.Object({
	...launchOptionProperties,
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Default: 1800000 ms." })),
}, { additionalProperties: false });

export type LaunchOptions = Static<typeof launchOptionsValidationSchema>;

export const parameters = Type.Object({
	action: Type.Optional(StringEnum(["status", "list", "result", "wait", "cancel", "interrupt", "resume", "steer", "report"] as const, { description: "Omit to launch." })),
	task: Type.Optional(Type.String({ minLength: 1, description: "Task for a new run." })),
	// An open configuration object preserves optional fields on Responses transports
	// that otherwise implicitly constrain closed schemas. Execution validates its exact keys/types.
	options: Type.Optional(Type.Unsafe<LaunchOptions>({
		type: "object",
		properties: launchOptionsSchema.properties,
		additionalProperties: true,
		description: "Launch options. Omit for defaults.",
	})),
	async: Type.Optional(Type.Boolean({ description: "Omit to wait. true returns an ID before completion." })),
	id: Type.Optional(Type.String({ minLength: 1, description: "Run ID." })),
	message: Type.Optional(Type.String({ minLength: 1, description: "steer, report, or resume message." })),
}, { additionalProperties: false });

export type Params = Static<typeof parameters>;

export function validateParams(value: unknown): Params {
	if (!Check(parameters, value)) throw new Error("Invalid subagent parameters. Use task and optional options for launch; action/id/message for management; async is available for both.");
	if (value.options !== undefined && !Check(launchOptionsValidationSchema, value.options)) {
		throw new Error("Invalid options. Supported keys/types: requirementsFile/string, model/string, maxDepth/integer >= 1, context/fresh|fork, cwd/string, timeoutMs/integer >= 1.");
	}
	return value;
}
