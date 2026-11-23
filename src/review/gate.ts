import type { Config } from "../config/schema";
import { run } from "../run";
import {
	completedRounds,
	type ReviewFinding,
	type ReviewRecord,
} from "./types";

export type GateResult =
	| { kind: "allow"; notice?: string; coverage?: string }
	| {
			kind: "deny";
			reason: string;
			openCount?: number;
			coverage?: string;
			capped?: true;
	  };

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
	"Commit, run `cagr review`, fix or answer Important findings, and re-check while rounds remain. Push once, after every Important finding is verified fixed or answered.";

export const cappedReview = (maxRounds: number) =>
	`Review is capped at ${maxRounds} round${maxRounds === 1 ? "" : "s"} for this branch.`;

export const cappedNext =
	'Fix only findings that break the intended case, answer the rest with `cagr review answer <id> --wrong|--intentional|--minor "<why>"`, then push.';

export const cappedFix =
	"Commit fixes and run `cagr review` to verify them without using a round.";

export const answerHint = (id: string) =>
	`If a finding is wrong or intentional, answer it instead: \`cagr review answer ${id} --wrong "<why>"\` (or --intentional, or --minor). A person reads every answer.`;

export const findingLine = (finding: ReviewFinding) =>
	`${finding.id} ${finding.file}${finding.line > 0 ? `:${finding.line}` : ""}  ${finding.title}`;

/** Whether a commit is the judged head or one of its ancestors. */
export type Reach = {
	(commit: string): boolean;
	/**
	 * Set only after a failed round: fixed findings whose fix commit the head
	 * does not contain, but whose fix's files (the files the fix round covered,
	 * and the finding's own) are at the head as the fix left them: a rebase,
	 * not a reset to before the fix.
	 */
	kept?: ReadonlySet<string>;
};

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
	const reach: Reach = (commit) => reached.has(commit);
	if (record.rounds.at(-1)?.error) {
		const kept = new Set<string>();
		await Promise.all(
			record.findings.map(async (finding) => {
				if (
					finding.status !== "fixed" ||
					!finding.fixedIn ||
					reached.has(finding.fixedIn)
				)
					return;
				const fix = record.rounds.findLast(
					(round) => !round.error && round.head === finding.fixedIn,
				);
				if (!fix) return;
				const changed = await run(
					["git", "diff", "--name-only", "-z", fix.from, fix.head],
					cwd,
				);
				if (!changed.ok) return;
				const files = [
					...changed.stdout.split("\0").filter(Boolean),
					...(finding.file ? [finding.file] : []),
				];
				if (files.length === 0) return;
				const same = await run(
					[
						"git",
						"diff",
						"--quiet",
						finding.fixedIn,
						target,
						"--",
						...files.map((file) => `:(literal)${file}`),
					],
					cwd,
				);
				if (same.ok) kept.add(finding.id);
			}),
		);
		reach.kept = kept;
	}
	return reach;
}

/**
 * Whether an unresolved finding still holds the gate after a failed round:
 * an open one does, and so does a fix the head does not have. A fix a rebase
 * carried over unchanged is unchecked, not open, so it fails open.
 */
export const holdsOnError = (finding: ReviewFinding, reach?: Reach) =>
	finding.status === "open" || !reach?.kept?.has(finding.id);

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

/** Describes the gap since the last completed round, excluding commits from the base. */
export async function unreviewedNotice(
	record: ReviewRecord,
	head: string,
	cwd: string,
	maxRounds: number,
): Promise<string | undefined> {
	if (
		record.rounds.some(
			(round) => !round.error && !round.verificationOnly && round.head === head,
		)
	)
		return;
	const last = record.rounds.findLast(
		(round) => !round.error && !round.verificationOnly,
	);
	if (!last) return;
	const prefix = `Reviewed through round ${last.n} (cap ${maxRounds});`;
	const remoteBase = await run(
		["git", "rev-parse", "--verify", "-q", `origin/${record.base}^{commit}`],
		cwd,
	);
	const count = await run(
		[
			"git",
			"rev-list",
			"--count",
			head,
			"--not",
			"--ignore-missing",
			last.head,
			remoteBase.ok ? remoteBase.stdout.trim() : record.base,
			"--",
		],
		cwd,
	);
	const later = count.ok ? Number(count.stdout.trim()) : 0;
	return later > 0
		? `${prefix} ${later} later commit${later === 1 ? " was" : "s were"} not reviewed.`
		: `${prefix} this commit was not reviewed.`;
}

export async function gateAtHead(
	record: ReviewRecord | null,
	head: string | null,
	config: Config,
	cwd: string,
): Promise<GateResult> {
	const [reach, coverage] = await Promise.all([
		reachFrom(record, head, cwd),
		record && head && completedRounds(record) >= config.review.max_rounds
			? unreviewedNotice(record, head, cwd, config.review.max_rounds)
			: undefined,
	]);
	return gateResult(record, head, config, reach, coverage);
}

/** Whether the commit `head` may become a pull request. */
export function gateResult(
	record: ReviewRecord | null,
	head: string | null,
	config: Config,
	reach?: Reach,
	coverage?: string,
): GateResult {
	const last = record?.rounds.at(-1);
	if (!record || !last)
		return {
			kind: "deny",
			reason: `This branch has not been reviewed. ${reviewOrder} Give the review a 15 minute timeout, then run this command again.`,
		};
	const target = head ?? last.head;
	const list = (findings: ReviewFinding[]) =>
		findings.map((finding) => `- ${findingLine(finding)}`).join("\n");
	if (completedRounds(record) >= config.review.max_rounds) {
		const remaining = unresolved(record, target, reach);
		if (remaining.length === 0)
			return coverage
				? { kind: "allow", notice: coverage, coverage }
				: { kind: "allow" };
		return {
			kind: "deny",
			openCount: remaining.length,
			capped: true,
			coverage,
			reason: [
				cappedReview(config.review.max_rounds),
				coverage,
				`Open Important findings:\n${list(remaining)}`,
				cappedNext,
				cappedFix,
			]
				.filter(Boolean)
				.join("\n\n"),
		};
	}
	const open = openAt(record, target, reach);
	if (open === null) {
		return {
			kind: "deny",
			reason: `This commit differs from the last review (${last.head.slice(0, 7)}). Run \`cagr review\` to check the new commits. Fix or answer every Important finding, then push and run this command again.`,
		};
	}
	if (last.error && (head === null || last.head === head)) {
		// Fail open only on what the failed round would have checked: findings already known still hold.
		const held = open.filter((finding) => holdsOnError(finding, reach));
		return held.length === 0
			? {
					kind: "allow",
					notice: `cagr: the review of ${last.head.slice(0, 7)} could not run (${last.error}), so ${record.rounds.some((round) => !round.error) ? "its newest commits go" : "this pull request goes"} out unreviewed. Review it yourself before you approve it.`,
				}
			: {
					kind: "deny",
					openCount: held.length,
					reason: `The last review could not run (${last.error}), and earlier rounds left ${held.length} important problem${held.length === 1 ? "" : "s"} open:\n${list(held)}\n\nFix the findings, commit, and re-check with \`cagr review\` before pushing. ${answerHint(held[0]?.id ?? "f1")}`,
				};
	}
	if (open.length === 0) return { kind: "allow" };
	return {
		kind: "deny",
		openCount: open.length,
		reason: `The review found ${open.length} important problem${open.length === 1 ? "" : "s"} still open:\n${list(open)}\n\nFix the findings, commit, and re-check with \`cagr review\` before pushing. ${answerHint(open[0]?.id ?? "f1")}`,
	};
}
