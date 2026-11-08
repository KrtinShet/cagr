import { ConfigError, loadConfig } from "../config/load";
import type { AgentName, Config } from "../config/schema";
import { parseInput, renderDecision } from "./adapters";
import { handle } from "./handlers";
import { recordTimings } from "./timings";
import type { AgentEvent, Decision } from "./types";

/**
 * One agent hook call: the agent's JSON in, its output text back. A broken
 * config or an internal error lets the call through and tells the human, so
 * guardwright never stops an agent for its own failure.
 */
export async function runHook(
	agent: AgentName,
	event: AgentEvent,
	stdin: string,
	fallbackCwd: string,
	load: (cwd: string) => Config | null = loadConfig,
): Promise<string> {
	const started = performance.now();
	let decision: Decision;
	let root: string | null = null;
	// A reviewer agent started by `guardwright review` is read-only and must not be held by the author's checks.
	if (process.env.GUARDWRIGHT_REVIEWER) return "";
	try {
		const payload = stdin.trim() === "" ? {} : JSON.parse(stdin);
		const input = parseInput(agent, event, payload, fallbackCwd);
		const config = load(input.cwd);
		root = config?.root ?? null;
		decision = config ? await handle(input, config) : { kind: "allow" };
	} catch (error) {
		const message =
			error instanceof ConfigError
				? error.message
				: `${(error as Error).stack ?? error}`;
		decision = {
			kind: "allow",
			notice: `guardwright is off for this call because of an error. ${message}`,
		};
	}
	if (root)
		recordTimings(root, [
			{ event, check: "total", ms: Math.round(performance.now() - started) },
		]);
	return renderDecision(agent, event, decision);
}
