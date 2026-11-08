import type { Effort, RiskTier } from "../config/schema";
import { findingLine } from "./gate";
import {
	type Candidate,
	categories,
	type ReviewFinding,
	severities,
} from "./types";

export type Focus = "bugs" | "security" | "behavior";

export type ReviewContext = {
	branch: string;
	from: string;
	head: string;
	scope: "full" | "diff" | "scan";
	tier: RiskTier;
	tierReasons: string[];
	effort: Effort;
	round: number;
	maxRounds: number;
	log: string;
	diff: string;
	guide: string | null;
	skip: string[];
	scan: string[];
	previous: ReviewFinding[];
};

const strict = (properties: Record<string, unknown>) => ({
	type: "object",
	additionalProperties: false,
	properties,
	required: Object.keys(properties),
});

const candidateSchema = strict({
	severity: { type: "string", enum: severities },
	category: { type: "string", enum: categories },
	file: { type: "string", description: "Path from the repo root." },
	line: {
		type: "integer",
		description: "Line in the file at the reviewed commit, or 0.",
	},
	title: { type: "string", description: "One sentence: what goes wrong." },
	detail: {
		type: "string",
		description: "The evidence: which input or state, and what happens.",
	},
	bug_class: {
		type: "string",
		description:
			"The class of bug, so the author can fix every instance. Empty if none.",
	},
});

export const finderSchema = strict({
	summary: {
		type: "string",
		description: 'Starts with the count, like "2 important, 1 nit."',
	},
	findings: { type: "array", items: candidateSchema },
	fixed: {
		type: "array",
		items: { type: "string" },
		description: "Ids of earlier open findings this commit fixed.",
	},
});

export const verifierSchema = strict({
	candidates: {
		type: "array",
		items: strict({
			id: { type: "string" },
			real: { type: "boolean" },
			severity: { type: "string", enum: severities },
			reason: { type: "string" },
		}),
	},
	previous: {
		type: "array",
		items: strict({
			id: { type: "string" },
			fixed: { type: "boolean" },
			reason: { type: "string" },
		}),
	},
});

export type FinderOutput = {
	summary: string;
	findings: Candidate[];
	fixed: string[];
};
export type VerifierOutput = {
	candidates: {
		id: string;
		real: boolean;
		severity: Candidate["severity"];
		reason: string;
	}[];
	previous: { id: string; fixed: boolean; reason: string }[];
};

const focusText: Record<Focus, string> = {
	bugs: "Correctness: wrong conditions, off-by-one errors, null, empty and error paths, races, resource leaks, and callers of changed functions that now break.",
	security:
		'Security: injection (shell, SQL, HTML), path traversal, missing auth or permission checks, secrets in code or logs, unsafe deserialization, server-side request forgery, and unsafe handling of untrusted input. Set category to "security".',
	behavior:
		"Behavior end to end: does the change do what its commits say? Edge cases, missing tests for new behavior, changed public interfaces and their callers, config, migration and compatibility effects.",
};

function scopeText(context: ReviewContext) {
	if (context.scope === "scan")
		return `You are reviewing existing code in ${context.scan.join(", ")} at ${context.head.slice(0, 12)} for bugs that have not surfaced yet. List the files with \`git ls-files\`.`;
	const range = `${context.from.slice(0, 12)}..${context.head.slice(0, 12)}`;
	return context.scope === "diff"
		? `You are reviewing only the commits added since the last review round (${range}) on branch ${context.branch}. Earlier commits were already reviewed.`
		: `You are reviewing branch ${context.branch}: every commit in ${range}.`;
}

function shared(context: ReviewContext) {
	const parts = [
		"You are a code reviewer in a fresh context. You did not write this change. Find real problems that would hurt a user or a teammate if it shipped.",
		"",
		scopeText(context),
		`Risk tier: ${context.tier}${context.tierReasons.length > 0 ? ` (${context.tierReasons.join("; ")})` : ""}.`,
	];
	if (context.log.trim() !== "")
		parts.push(
			"",
			"The author's intent, from the commit messages:",
			context.log.trim(),
		);
	parts.push(
		"",
		"## How to review",
		"- Read the diff, then read whatever files you need to judge it. You may run `git diff`, `git log`, `git show`, `git blame`, `git grep` and `git ls-files`. Do not change any file.",
		"- Report a finding only with evidence: a file, a line, and what goes wrong for which input or state.",
		"- For a bug fix, check that it fixes the root cause and not one symptom.",
		"- When you find a bug, look for the same class of bug elsewhere in the change, report each instance, and name the class in bug_class.",
		'- severity "important": a bug, a security hole, data loss, a broken contract, or new behavior with no test that could break. "nit": small and worth fixing. "pre-existing": a real problem the change did not introduce.',
		'- Do not report style, formatting, naming or cleanup-only issues; linters handle those. If you report one anyway, set category to "style".',
		"- At most 3 nits.",
		"- If there is nothing to fix, return no findings and say so plainly in the summary.",
		'- The summary starts with the count, like "2 important, 1 nit."',
	);
	if (context.guide)
		parts.push("", "## This repo's review guide", context.guide.trim());
	if (context.skip.length > 0)
		parts.push(
			"",
			"## Do not review these paths",
			...context.skip.map((glob) => `- ${glob}`),
		);
	if (context.previous.length > 0)
		parts.push(
			"",
			"## Already reported in earlier rounds",
			"Do not report these again.",
			...context.previous.map(
				(finding) =>
					`- ${findingLine(finding)} [${finding.severity}, ${finding.status}${finding.answer ? `, answered ${finding.answer.kind}: ${finding.answer.reason}` : ""}]`,
			),
		);
	if (context.round > context.maxRounds)
		parts.push(
			"",
			"## Round limit",
			`This is review round ${context.round}; the cap is ${context.maxRounds}. Report only important problems in the new commits. If the same kind of problem keeps coming back, say in the summary that the author should step back and reconsider the approach.`,
		);
	return parts;
}

function diffSection(context: ReviewContext) {
	if (context.scope === "scan") return [];
	return ["", "## The diff", "```diff", context.diff, "```"];
}

export function finderPrompt(context: ReviewContext, focus: Focus) {
	const open = context.previous.filter((finding) => finding.status === "open");
	return [
		...shared(context),
		"",
		"## Your focus",
		focusText[focus],
		...(open.length > 0
			? [
					"",
					`In \`fixed\`, list the ids of these open findings that the code at ${context.head.slice(0, 12)} no longer has: ${open.map((finding) => finding.id).join(", ")}.`,
				]
			: []),
		...diffSection(context),
	].join("\n");
}

export function verifierPrompt(
	context: ReviewContext,
	candidates: (Candidate & { key: string })[],
) {
	const open = context.previous.filter((finding) => finding.status === "open");
	return [
		`You check other reviewers' findings on branch ${context.branch} (${context.from.slice(0, 12)}..${context.head.slice(0, 12)}), independently, in a fresh context. Do not change any file.`,
		"",
		"For each candidate, read the code and decide whether it is real: the file and line exist at the reviewed commit and the failure happens as described. Speculative, style-only, and already-handled findings are not real. You may change the severity.",
		...(open.length > 0
			? [
					"",
					`Then, for each previous open finding, decide whether the code at ${context.head.slice(0, 12)} has fixed it.`,
				]
			: []),
		...(context.guide
			? ["", "## This repo's review guide", context.guide.trim()]
			: []),
		"",
		"## Candidates",
		...(candidates.length > 0
			? candidates.map(
					(candidate) =>
						`- ${candidate.key} [${candidate.severity}/${candidate.category}] ${candidate.file}:${candidate.line} ${candidate.title}\n  ${candidate.detail.replace(/\n/g, "\n  ")}`,
				)
			: ["(none)"]),
		...(open.length > 0
			? [
					"",
					"## Previous open findings",
					...open.map(
						(finding) =>
							`- ${findingLine(finding)}\n  ${finding.detail.replace(/\n/g, "\n  ")}`,
					),
				]
			: []),
		...diffSection(context),
	].join("\n");
}
