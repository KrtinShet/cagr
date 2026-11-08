import { answerHint, findingLine, runReview } from "./gate";
import type { ReviewOutcome } from "./review";
import {
	type AnswerKind,
	blocking,
	type ReviewFinding,
	type ReviewRecord,
} from "./types";

const block = (finding: ReviewFinding) => {
	const lines = [`- ${findingLine(finding)}`];
	if (finding.detail) lines.push(`  ${finding.detail.replace(/\n/g, "\n  ")}`);
	if (finding.bug_class)
		lines.push(
			`  Class: ${finding.bug_class}. Check for the same problem elsewhere.`,
		);
	return lines.join("\n");
};

/** What `cagr review` prints: counts first, then the findings, then what to do next. */
export function reviewReport(
	outcome: ReviewOutcome,
	maxRounds: number,
): string {
	if (outcome.skipped) {
		const open = blocking(outcome.record);
		return open.length > 0
			? `${outcome.skipped}\n\nStill open:\n${open.map(block).join("\n")}\n\nFix them, commit, and run \`cagr review\` again. ${answerHint(open[0]?.id ?? "f1")}`
			: outcome.skipped;
	}
	const round = outcome.round;
	if (round?.error)
		return `The reviewer could not run: ${round.error}\n\nThe gate lets the pull request through and tells the human it went out unreviewed. Fix the reviewer and run \`cagr review\` again if you can.`;
	const sections: string[] = [
		`Round ${round?.n ?? 1}${round ? ` (${round.scope}, ${round.effort}, ${round.tier} risk, ${round.reviewer})` : ""}: ${round?.summary ?? ""}`,
	];
	if (outcome.fixed.length > 0)
		sections.push(
			`Fixed since the last round:\n${outcome.fixed.map((finding) => `- ${findingLine(finding)}`).join("\n")}`,
		);
	const of = (severity: ReviewFinding["severity"]) =>
		outcome.found.filter((finding) => finding.severity === severity);
	if (of("important").length > 0)
		sections.push(`Important:\n${of("important").map(block).join("\n")}`);
	if (of("nit").length > 0)
		sections.push(`Nits (optional):\n${of("nit").map(block).join("\n")}`);
	if (of("pre-existing").length > 0)
		sections.push(
			`Pre-existing (not from this branch, optional):\n${of("pre-existing").map(block).join("\n")}`,
		);
	const open = blocking(outcome.record);
	const older = open.filter((finding) => !outcome.found.includes(finding));
	if (older.length > 0)
		sections.push(
			`Still open from earlier rounds:\n${older.map(block).join("\n")}`,
		);
	if (open.length === 0)
		sections.push(
			"Passed. No Important finding is open, so the gate lets the pull request through.",
		);
	else {
		const steps = `Next: fix each Important finding, commit, and run \`cagr review\` again. It reviews only the new commits. ${answerHint(open[0]?.id ?? "f1")}`;
		const rounds = outcome.record.rounds.filter((entry) => !entry.error).length;
		sections.push(
			rounds >= maxRounds
				? `${steps}\n\nThis is round ${rounds} of ${maxRounds}. Step back before another round: if findings keep coming, the approach may be wrong. Rethink it, or answer the findings and let a person decide.`
				: steps,
		);
	}
	return sections.join("\n\n");
}

export function statusReport(
	record: ReviewRecord | null,
	head: string | null,
): string {
	if (!record || record.rounds.length === 0)
		return `Not reviewed yet. ${runReview}`;
	const last = record.rounds.at(-1);
	const lines = [
		`${record.branch}: ${record.rounds.length} round${record.rounds.length === 1 ? "" : "s"}, last at ${last?.head.slice(0, 7)}${last?.head === head ? " (the current commit)" : ", before your latest commit"}.`,
	];
	for (const status of ["open", "answered", "fixed"] as const) {
		const findings = record.findings.filter(
			(finding) => finding.status === status,
		);
		if (findings.length === 0) continue;
		lines.push(
			"",
			`${status[0]?.toUpperCase()}${status.slice(1)}:`,
			...findings.map(
				(finding) =>
					`- [${finding.severity}] ${findingLine(finding)}${finding.answer ? `  (${finding.answer.kind}: ${finding.answer.reason})` : ""}`,
			),
		);
	}
	return lines.join("\n");
}

export class AnswerError extends Error {}

/** Records a reply to a finding. Any finding can be answered, so a review can always finish. */
export function answerFinding(
	record: ReviewRecord | null,
	id: string,
	kind: AnswerKind,
	reason: string,
): ReviewFinding {
	if (reason.trim().length < 8)
		throw new AnswerError(
			"Give a reason a person can check, in a sentence: why the finding is wrong, intentional or minor.",
		);
	const finding = record?.findings.find((entry) => entry.id === id);
	if (!finding)
		throw new AnswerError(
			`No finding "${id}" on this branch. \`cagr review status\` lists them.`,
		);
	finding.status = "answered";
	finding.answer = { kind, reason: reason.trim() };
	return finding;
}

export type ReviewStats = {
	branches: number;
	passed: number;
	meanRounds: number | null;
	passedFirstRound: number | null;
	fiveOrMore: number | null;
	findings: number;
	important: number;
	answers: Record<AnswerKind, number>;
	fixed: number;
	errors: number;
};

/** Rounds-to-pass and how findings were handled, across every branch's record. */
export function reviewStats(records: ReviewRecord[]): ReviewStats {
	const ran = records.filter((record) =>
		record.rounds.some((round) => !round.error),
	);
	const passedRounds: number[] = [];
	for (const record of ran) {
		if (blocking(record).length > 0) continue;
		passedRounds.push(record.rounds.filter((round) => !round.error).length);
	}
	const findings = records.flatMap((record) => record.findings);
	const share = (count: number) =>
		passedRounds.length === 0 ? null : count / passedRounds.length;
	const answers = { wrong: 0, intentional: 0, minor: 0 };
	for (const finding of findings)
		if (finding.answer) answers[finding.answer.kind]++;
	return {
		branches: ran.length,
		passed: passedRounds.length,
		meanRounds:
			passedRounds.length === 0
				? null
				: passedRounds.reduce((a, b) => a + b, 0) / passedRounds.length,
		passedFirstRound: share(passedRounds.filter((n) => n === 1).length),
		fiveOrMore: share(passedRounds.filter((n) => n >= 5).length),
		findings: findings.length,
		important: findings.filter((finding) => finding.severity === "important")
			.length,
		answers,
		fixed: findings.filter((finding) => finding.status === "fixed").length,
		errors: records
			.flatMap((record) => record.rounds)
			.filter((round) => round.error).length,
	};
}

const percent = (value: number | null) =>
	value === null ? "n/a" : `${Math.round(value * 100)}%`;

export function statsReport(stats: ReviewStats): string {
	if (stats.branches === 0) return "No reviews yet.";
	const answered =
		stats.answers.wrong + stats.answers.intentional + stats.answers.minor;
	return [
		`${stats.branches} branch${stats.branches === 1 ? "" : "es"} reviewed, ${stats.passed} passing.`,
		`Rounds to pass: mean ${stats.meanRounds === null ? "n/a" : stats.meanRounds.toFixed(1)}, ${percent(stats.passedFirstRound)} in one round, ${percent(stats.fiveOrMore)} needed five or more.`,
		`Findings: ${stats.findings} (${stats.important} important). Fixed: ${stats.fixed}. Answered: ${answered} (wrong ${stats.answers.wrong}, intentional ${stats.answers.intentional}, minor ${stats.answers.minor}).`,
		...(stats.findings > 0
			? [
					`Noise: ${percent(stats.answers.wrong / stats.findings)} of findings were answered as wrong. Read those answers to tune REVIEW.md.`,
				]
			: []),
		...(stats.errors > 0
			? [
					`The reviewer failed to run ${stats.errors} time${stats.errors === 1 ? "" : "s"}.`,
				]
			: []),
	].join("\n");
}
