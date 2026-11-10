import type { TurnState } from "./turn-state";

export type CheckResult = { name: string; ok: boolean; output: string };

export type StopDecision =
	| { action: "allow" }
	| { action: "block"; reason: string }
	| { action: "give-up"; message: string };

// After this many blocked stops the agent is let go, so an error it cannot fix
// never traps it in a loop. The user is told instead.
export const maxFailedStops = 3;
const maxOutputPerCheck = 3000;

// Only edits in the checkout being checked count: after a merge removes the worktree,
// the hook runs in the main checkout, which those edits never touched.
export function needsCheck(state: TurnState, repoRoot: string) {
	return state.files.some((file) => file.startsWith(`${repoRoot}/`));
}

export function stopDecision(
	state: TurnState,
	results: CheckResult[],
): StopDecision {
	const failures = results.filter((result) => !result.ok);
	if (failures.length === 0) return { action: "allow" };
	const names = failures.map((failure) => failure.name).join(" and ");
	if (state.failedStops + 1 >= maxFailedStops) {
		return {
			action: "give-up",
			message: `${names} still failing after ${maxFailedStops} attempts.`,
		};
	}
	const details = failures
		.map(
			(failure) =>
				`## ${failure.name}\n${failure.name === "Change rules" ? failure.output.trim() : truncate(failure.output.trim(), maxOutputPerCheck)}`,
		)
		.join("\n\n");
	return {
		action: "block",
		reason: `You changed code this turn and ${names} failed. Fix these before finishing.\n\n${details}`,
	};
}

function truncate(text: string, limit: number) {
	return text.length <= limit
		? text
		: `${text.slice(0, limit)}\n... (cut, run the check to see the rest)`;
}
