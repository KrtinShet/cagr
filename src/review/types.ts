import type { Effort, RiskTier } from "../config/schema";

export const severities = ["important", "nit", "pre-existing"] as const;
export type Severity = (typeof severities)[number];
export const categories = [
	"bug",
	"security",
	"behavior",
	"test",
	"style",
	"other",
] as const;
export type Category = (typeof categories)[number];
export const answerKinds = ["wrong", "intentional", "minor"] as const;
export type AnswerKind = (typeof answerKinds)[number];

/** A finding as a reviewer agent reports it. */
export type Candidate = {
	severity: Severity;
	category: Category;
	file: string;
	line: number;
	title: string;
	detail: string;
	bug_class: string;
};

export type ReviewFinding = Candidate & {
	id: string;
	round: number;
	status: "open" | "fixed" | "answered";
	answer: { kind: AnswerKind; reason: string } | null;
	fixedIn: string | null;
	/** Verdicts the verifier gave while the finding was open. Older records lack it. */
	verdicts?: number;
};

export type Round = {
	n: number;
	head: string;
	from: string;
	scope: "full" | "diff" | "verify" | "scan";
	effort: Effort;
	tier: RiskTier;
	reviewer: string;
	at: string;
	summary: string;
	/** Set when the reviewer could not run. The gate then lets the PR through and tells the human. */
	error: string | null;
	/** The earlier findings the verifier judged in this round. Older records lack it. */
	verified?: string[];
};

export type ReviewRecord = {
	version: 1;
	branch: string;
	base: string;
	rounds: Round[];
	findings: ReviewFinding[];
};

export const emptyRecord = (branch: string, base: string): ReviewRecord => ({
	version: 1,
	branch,
	base,
	rounds: [],
	findings: [],
});

/** Open findings that keep the gate closed. */
export const blocking = (record: ReviewRecord) =>
	record.findings.filter(
		(finding) => finding.status === "open" && finding.severity === "important",
	);

/**
 * The number of the round that started the current review cycle: the last
 * full round that ran. A rebase, a reused branch name or `--full` starts a new
 * cycle for the verifier's context.
 */
export const cycleStart = (record: ReviewRecord) =>
	record.rounds.findLast((round) => !round.error && round.scope === "full")
		?.n ?? 0;

/** Every completed branch round counts toward `[review] max_rounds`. */
export const completedRounds = (record: ReviewRecord) =>
	record.rounds.filter((round) => !round.error).length;

export const extraReviewEnv = "CAGR_ALLOW_EXTRA_REVIEW";
