import { ConfigError, loadConfig } from "../config/load";
import type { AgentName, Config } from "../config/schema";
import { parseInput, renderDecision } from "./adapters";
import { handle } from "./handlers";
import {
	collectStats,
	commandTarget,
	type Observation,
	recordStats,
} from "./stats";
import { recordTimings } from "./timings";
import type { AgentEvent, Decision } from "./types";

/**
 * One agent hook call: the agent's JSON in, its output text back. A broken
 * config or an internal error lets the call through and tells the human, so
 * cagr never stops an agent for its own failure.
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
	let root: string | null = fallbackCwd;
	let enabled = true;
	let session = "unknown";
	let target = "";
	let key = "";
	const entries: Observation[] = [];
	try {
		const payload = stdin.trim() === "" ? {} : JSON.parse(stdin);
		const input = parseInput(agent, event, payload, fallbackCwd);
		session = input.sessionId;
		target = input.command
			? commandTarget(input.command)
			: (input.files[0] ?? "").slice(0, 200);
		key = Bun.hash(input.command ?? target).toString(36);
		const config = load(input.cwd);
		enabled = config?.stats.enabled ?? true;
		root = config?.root ?? null;
		decision = config
			? await collectStats(entries, () => handle(input, config))
			: { kind: "allow" };
		if (config && event === "session.start")
			entries.push({ id: "session", decision: "session", target: "" });
		if (decision.kind === "deny" && !entries.length) {
			const id = /\(cagr: ([^)]+)\)/.exec(decision.reason)?.[1] ?? "guard";
			entries.push({ id, decision: "deny", target, key });
		}
	} catch (error) {
		const message =
			error instanceof ConfigError
				? error.message
				: `${(error as Error).stack ?? error}`;
		entries.length = 0;
		entries.push({ id: "hook-error", decision: "fail-open", target });
		decision = {
			kind: "allow",
			notice: `cagr is off for this call because of an error. ${message}`,
		};
	}
	if (entries.some((e) => e.decision === "stop-escape"))
		for (const entry of entries)
			if (entry.decision === "block") entry.decision = "stop-escape";
	if (root && enabled) recordStats(root, event, agent, session, entries);
	if (root)
		recordTimings(root, [
			{ event, check: "total", ms: Math.round(performance.now() - started) },
		]);
	return renderDecision(agent, event, decision);
}
