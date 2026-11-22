import type { Config } from "../config/schema";
import { run } from "../run";
import {
	discoveryRounds,
	type ReviewFinding,
	type ReviewRecord,
} from "./types";

export type GateResult =
	| { kind: "allow"; notice?: string }
	| { kind: "deny"; reason: string };

export const runReview =
	"Run `cagr review`. It starts a reviewer agent in a fresh context and takes a few minutes, so give the command a 15 minute timeout.";

export const reviewPreparation = [
	"Before `cagr review`, make sure each new behavior or bug fix has a test that fails without it.",
	"Put the intent and any deliberate trade-offs in the commit body.",
	"Fix every finding in one commit, covering the whole bug class.",
	"Run the targeted tests before asking for the next round.",
]
	.map((line) => `- ${line}`)
	.join("\n");

export const reviewOrder =
	"Commit, run `cagr review`, fix or answer every Important finding, then re-check any new commits. Push once the review passes.";

export const cappedReview =
	"The round cap has been reached, so no further full round runs. For new commits, `cagr review` runs finders on their diff and the verifier on earlier findings.";

export const answerHint = (id: string) =>
	`If a finding is wrong or intentional, answer it instead: \`cagr review answer ${id} --wrong "<why>"\` (or --intentional, or --minor). A person reads every answer.`;

export const findingLine = (finding: ReviewFinding) =>
	`${finding.id} ${finding.file}${finding.line > 0 ? `:${finding.line}` : ""}  ${finding.title}`;

/** Whether a commit is the judged head or one of its ancestors. */
export type Reach = (commit: string) => boolean;

/**
 * Which commits where findings were judged fixed are `head` or its ancestors.
 * A fix judged on a later commit, or on history a rebase dropped, does not
 * count for `head`.
 */
export async function reachFrom(
	record: ReviewRecord | null,
	head: string | null,
	cwd: string,
): Promise<Reach> {
	const target = head ?? record?.rounds.at(-1)?.head;
	if (!record || !target) return () => false;
	const reached = new Set([target]);
	const commits = new Set(
		record.findings.flatMap((finding) =>
			finding.status === "fixed" &&
			finding.fixedIn &&
			finding.fixedIn !== target
				? [finding.fixedIn]
				: [],
		),
	);
	await Promise.all(
		[...commits].map(async (commit) => {
			if (
				(await run(["git", "merge-base", "--is-ancestor", commit, target], cwd))
					.ok
			)
				reached.add(commit);
		}),
	);
	return (commit) => reached.has(commit);
}

/**
 * The Important findings not closed at `head`: open ones, and fixed ones whose
 * fix was judged on a commit that `head` does not contain. A fixed finding
 * from an older record with no fix commit counts as fixed only at the last
 * reviewed head. Answered findings stay closed at every head.
 */
export function unresolved(
	record: ReviewRecord,
	head: string,
	reach: Reach = (commit) => commit === head,
): ReviewFinding[] {
	const last = record.rounds.at(-1)?.head;
	return record.findings.filter(
		(finding) =>
			finding.severity === "important" &&
			(finding.status === "open" ||
				(finding.status === "fixed" &&
					!(finding.fixedIn === null
						? head === last
						: reach(finding.fixedIn)))),
	);
}

/**
 * The Important findings open against `head`, or null when no round that ran
 * reviewed it. An older head answers for the findings known when it was
 * reviewed, so a finding that a later round reopens holds it too.
 */
export function openAt(
	record: ReviewRecord,
	head: string,
	reach?: Reach,
): ReviewFinding[] | null {
	const open = unresolved(record, head, reach);
	if (record.rounds.at(-1)?.head === head) return open;
	const prior = record.rounds.findLast(
		(round) => round.head === head && !round.error,
	);
	return prior ? open.filter((finding) => finding.round <= prior.n) : null;
}

/** Whether the commit `head` may become a pull request. */
export function gateResult(
	record: ReviewRecord | null,
	head: string | null,
	config: Config,
	reach?: Reach,
): GateResult {
	const last = record?.rounds.at(-1);
	if (!record || !last)
		return {
			kind: "deny",
			reason: `This branch has not been reviewed. ${reviewOrder} Give the review a 15 minute timeout, then run this command again.`,
		};
	const open = openAt(record, head ?? last.head, reach);
	if (open === null) {
		const next =
			discoveryRounds(record) >= config.review.max_rounds
				? cappedReview
				: "Run `cagr review` to check the new commits.";
		return {
			kind: "deny",
			reason: `This commit differs from the last review (${last.head.slice(0, 7)}). ${next} Fix or answer every Important finding, then push and run this command again.`,
		};
	}
	const list = open.map((finding) => `- ${findingLine(finding)}`).join("\n");
	if (last.error && (head === null || last.head === head))
		// Fail open only on what the failed round would have checked: findings already known still hold.
		return open.length === 0
			? {
					kind: "allow",
					notice: `cagr: the review of ${last.head.slice(0, 7)} could not run (${last.error}), so ${record.rounds.some((round) => !round.error) ? "its newest commits go" : "this pull request goes"} out unreviewed. Review it yourself before you approve it.`,
				}
			: {
					kind: "deny",
					reason: `The last review could not run (${last.error}), and earlier rounds left ${open.length} important problem${open.length === 1 ? "" : "s"} open:\n${list}\n\nFix the findings, commit, and re-check with \`cagr review\` before pushing. ${answerHint(open[0]?.id ?? "f1")}`,
				};
	if (open.length === 0) return { kind: "allow" };
	const capped =
		discoveryRounds(record) >= config.review.max_rounds
			? `\n\n${cappedReview}`
			: "";
	return {
		kind: "deny",
		reason: `The review found ${open.length} important problem${open.length === 1 ? "" : "s"} still open:\n${list}\n\nFix the findings, commit, and re-check with \`cagr review\` before pushing. ${answerHint(open[0]?.id ?? "f1")}${capped}`,
	};
}
