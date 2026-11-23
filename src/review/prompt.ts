import type { Effort, RiskTier } from "../config/schema";
import { findingLine } from "./gate";
import {
	type Candidate,
	categories,
	type ReviewFinding,
	type Round,
	severities,
} from "./types";

export type Focus = "bugs" | "security" | "behavior";

export type ReviewContext = {
	branch: string;
	from: string;
	head: string;
	scope: Round["scope"];
	tier: RiskTier;
	tierReasons: string[];
	effort: Effort;
	log: string;
	diff: string;
	guide: string | null;
	skip: string[];
	scan: string[];
	previous: ReviewFinding[];
	/** The round that started the current cycle: fixed findings from before it are not checked again. */
	cycleStart: number;
	/** Set on a recheck of an already reviewed commit: only findings from rounds before this one are verified again. */
	recheckBefore: number | null;
	/** Fixed findings whose fix was judged on a commit this head does not contain: the verifier checks them again. */
	stale: string[];
	/** Findings the verifier already judged twice at this head: they are not judged again here. */
	spent: string[];
	/** On the final diff round, recheck fixes made in this cycle. */
	recheckFixes: boolean;
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

const calibration = [
	'Severity "important" requires a concrete failing input or state and its consequence. Without both, use "nit".',
	"Do not report a choice the commit body names as deliberate unless it causes a bug or a security hole.",
];

function commitMessages(context: ReviewContext) {
	return context.log.trim() === ""
		? []
		: ["", "## Commit messages", context.log.trim()];
}

export function findingsToVerify(context: ReviewContext) {
	const { recheckBefore } = context;
	return context.previous.filter((finding) => {
		if (context.spent.includes(finding.id)) return false;
		if (recheckBefore !== null && finding.round >= recheckBefore) return false;
		if (context.stale.includes(finding.id)) return true;
		const recheckFix =
			finding.severity === "important" &&
			finding.status === "fixed" &&
			finding.round >= context.cycleStart;
		if (context.scope === "verify")
			return (
				recheckFix ||
				(finding.severity === "important" && finding.status === "open")
			);
		if (context.recheckFixes) return recheckFix || finding.status === "open";
		return finding.status === "open";
	});
}

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
	if (context.scope === "full")
		parts.push(
			"",
			"This is the only full review. Later rounds see only the commits added after it, so anything you miss now ships. Report every instance of every class now.",
		);
	parts.push(
		"",
		"## How to review",
		"- Read the diff, then read whatever files you need to judge it. You may run `git diff`, `git log`, `git show`, `git blame`, `git grep` and `git ls-files`. Do not change any file.",
		"- Report a finding only with evidence: a file, a line, and what goes wrong for which input or state.",
		"- For a bug fix, check that it fixes the root cause and not one symptom.",
		"- When you find a bug, look for the same class of bug elsewhere in the change, report each instance, and name the class in bug_class.",
		...calibration.map((line) => `- ${line}`),
		'- Severity "pre-existing" is for a problem the change did not introduce.',
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
	return parts;
}

function diffSection(context: ReviewContext) {
	if (context.scope === "scan") return [];
	return ["", "## The diff", "```diff", context.diff, "```"];
}

export function finderPrompt(context: ReviewContext, focus: Focus) {
	return [
		...shared(context),
		"",
		"## Your focus",
		focusText[focus],
		...commitMessages(context),
		...diffSection(context),
	].join("\n");
}

export function verifierPrompt(
	context: ReviewContext,
	candidates: (Candidate & { key: string })[],
) {
	const previous = findingsToVerify(context);
	return [
		`You check other reviewers' findings on branch ${context.branch} (${context.from.slice(0, 12)}..${context.head.slice(0, 12)}), independently, in a fresh context. Do not change any file.`,
		"",
		context.scope === "verify"
			? "This commit was already reviewed. Check the earlier findings below again at this commit. Return an empty candidates list."
			: "For each candidate, read the code and decide whether it is real: the file and line exist at the reviewed commit and the failure happens as described. Speculative, style-only, and already-handled findings are not real. You may change the severity.",
		...calibration,
		...(previous.length > 0
			? [
					"",
					`For each earlier finding below, read the diff and the code at ${context.head.slice(0, 12)}. Return a fixed or not fixed verdict and the evidence for it. A previously fixed finding needs confirmation that the fix still holds.`,
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
		...(previous.length > 0
			? [
					"",
					"## Earlier findings to verify",
					...previous.map(
						(finding) =>
							`- ${findingLine(finding)} [${finding.status}]\n  ${finding.detail.replace(/\n/g, "\n  ")}`,
					),
				]
			: []),
		...commitMessages(context),
		...diffSection(context),
	].join("\n");
}
