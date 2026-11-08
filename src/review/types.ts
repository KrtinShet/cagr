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
};

export type Round = {
	n: number;
	head: string;
	from: string;
	scope: "full" | "diff" | "scan";
	effort: Effort;
	tier: RiskTier;
	reviewer: string;
	at: string;
	summary: string;
	/** Set when the reviewer could not run. The gate then lets the PR through and tells the human. */
	error: string | null;
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
