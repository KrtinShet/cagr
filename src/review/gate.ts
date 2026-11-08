import type { Config } from "../config/schema";
import { blocking, type ReviewFinding, type ReviewRecord } from "./types";

export type GateResult =
	| { kind: "allow"; notice?: string }
	| { kind: "deny"; reason: string };

export const runReview =
	"Run `guardwright review`. It starts a reviewer agent in a fresh context and takes a few minutes, so give the command a 15 minute timeout.";

export const answerHint = (id: string) =>
	`If a finding is wrong or intentional, answer it instead: \`guardwright review answer ${id} --wrong "<why>"\` (or --intentional, or --minor). A person reads every answer.`;

export const findingLine = (finding: ReviewFinding) =>
	`${finding.id} ${finding.file}${finding.line > 0 ? `:${finding.line}` : ""}  ${finding.title}`;

/** Whether the commit `head` may become a pull request. */
export function gateResult(
	record: ReviewRecord | null,
	head: string | null,
	config: Config,
): GateResult {
	const last = record?.rounds.at(-1);
	if (!record || !last)
		return {
			kind: "deny",
			reason: `This branch has not been reviewed. ${runReview} Fix or answer what it finds, then run this command again.`,
		};
	if (head !== null && last.head !== head)
		return {
			kind: "deny",
			reason: `You committed after the last review (${last.head.slice(0, 7)}). ${runReview} It reviews only the new commits.`,
		};
	const open = blocking(record);
	const list = open.map((finding) => `- ${findingLine(finding)}`).join("\n");
	if (last.error)
		// Fail open only on what the failed round would have checked: findings already known still hold.
		return open.length === 0
			? {
					kind: "allow",
					notice: `guardwright: the review of ${last.head.slice(0, 7)} could not run (${last.error}), so ${record.rounds.some((round) => !round.error) ? "its newest commits go" : "this pull request goes"} out unreviewed. Review it yourself before you approve it.`,
				}
			: {
					kind: "deny",
					reason: `The last review could not run (${last.error}), and earlier rounds left ${open.length} important problem${open.length === 1 ? "" : "s"} open:\n${list}\n\nFix each one, commit, and run \`guardwright review\` again. ${answerHint(open[0]?.id ?? "f1")}`,
				};
	if (open.length === 0) return { kind: "allow" };
	const rounds = record.rounds.filter((round) => !round.error).length;
	const capped =
		rounds >= config.review.max_rounds
			? `\n\nThis branch has had ${rounds} review rounds. Step back: if findings keep coming, the approach may be wrong. Rethink it, or answer the findings and let a person decide.`
			: "";
	return {
		kind: "deny",
		reason: `The review found ${open.length} important problem${open.length === 1 ? "" : "s"} still open:\n${list}\n\nFix each one, commit, and run \`guardwright review\` again. ${answerHint(open[0]?.id ?? "f1")}${capped}`,
	};
}
