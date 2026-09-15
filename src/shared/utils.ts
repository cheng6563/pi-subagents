import { homedir } from "node:os";
import { join } from "node:path";

export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}
