import {
	emptyRecord,
	type ReviewFinding,
	type ReviewRecord,
	type Round,
} from "../review/types";

export const head = "a".repeat(40);

export const round = (extra: Partial<Round> = {}): Round => ({
	n: 1,
	head,
	from: "b".repeat(40),
	scope: "full",
	effort: "standard",
	tier: "medium",
	reviewer: "claude",
	at: "2026-11-08T00:00:00Z",
	summary: "",
	error: null,
	...extra,
});

export const finding = (extra: Partial<ReviewFinding> = {}): ReviewFinding => ({
	severity: "important",
	category: "bug",
	file: "src/a.ts",
	line: 4,
	title: "Crash on empty list",
	detail: "",
	bug_class: "",
	id: "f1",
	round: 1,
	status: "open",
	answer: null,
	fixedIn: null,
	...extra,
});

export const record = (
	rounds: Round[],
	findings: ReviewFinding[] = [],
	branch = "feat/x",
): ReviewRecord => ({ ...emptyRecord(branch, "main"), rounds, findings });
