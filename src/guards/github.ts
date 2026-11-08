import type { Config } from "../config/schema";
import { programWords, simpleCommands, withoutHeredocBodies } from "../shell";
import { containsWords } from "./command";
import type { Finding } from "./finding";

const commandsOf = (line: string) =>
	simpleCommands(withoutHeredocBodies(line)).map(programWords);

const mergeApi =
	/\/pulls\/[^/\s]+\/merge\b|\/merges\b|mergePullRequest|enablePullRequestAutoMerge/;
const reviewApi =
	/\/pulls\/[^/\s]+\/reviews\b|addPullRequestReview|submitPullRequestReview/;

export const githubReasons = {
	merge: () =>
		"Agents do not merge pull requests here. Say the pull request is ready and let a person review and merge it.",
	approve: () =>
		"An agent's approval does not count here. Leave a comment with `gh pr review --comment` if you need to, and let a person approve.",
};

/** `gh pr merge`, `gh pr review --approve` and the merge or review API, when agents may not merge. */
export function agentApprovalFinding(
	line: string,
	config: Config,
): Finding | null {
	if (config.review.agents_may_merge) return null;
	for (const words of commandsOf(line)) {
		if (words[0] !== "gh") continue;
		const [, group, action] = words;
		if (group === "pr" && action === "merge")
			return { id: "agent-approval", reason: githubReasons.merge() };
		if (
			group === "pr" &&
			action === "review" &&
			words.some(
				(word) => word === "--approve" || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(word),
			)
		)
			return { id: "agent-approval", reason: githubReasons.approve() };
		// The API can do both, so read the whole line: the path or the GraphQL mutation may sit in quotes.
		if (group !== "api") continue;
		if (mergeApi.test(line))
			return { id: "agent-approval", reason: githubReasons.merge() };
		if (reviewApi.test(line) && /APPROVE/.test(line))
			return { id: "agent-approval", reason: githubReasons.approve() };
	}
	return null;
}

/** Whether the line runs one of the [review] gate commands. */
export function isGateCommand(line: string, config: Config) {
	if (!config.review.enabled || config.review.gate.length === 0) return false;
	return commandsOf(line).some((words) =>
		config.review.gate.some((match) => containsWords(words, match)),
	);
}

export function prTemplate(sections: string[]) {
	return sections
		.map((section) => `## ${section}\n\n`)
		.join("")
		.trimEnd();
}

const bodyFlags = new Set([
	"--body",
	"-b",
	"--body-file",
	"-F",
	"--fill",
	"--fill-first",
	"--fill-verbose",
	"-f",
	"--template",
	"-T",
	"--web",
	"-w",
]);

/** On `gh pr create`, the body must carry each [review] pr_sections heading. */
export function prBodyFinding(
	line: string,
	config: Config,
	readFile: (path: string) => string | null,
): Finding | null {
	const sections = config.review.pr_sections;
	if (sections.length === 0) return null;
	const create = commandsOf(line).find(
		(words) => words[0] === "gh" && words[1] === "pr" && words[2] === "create",
	);
	if (!create) return null;
	const reason = (what: string) => ({
		id: "pr-body",
		reason: `${what} Pass the body with --body or --body-file, with these headings filled in:\n\n${prTemplate(sections)}`,
	});
	const used = create.filter(
		(word) => bodyFlags.has(word) || word.startsWith("--body="),
	);
	if (used.some((word) => word.startsWith("--fill") || word === "-f"))
		return reason(
			"--fill writes the body from commits, without the sections reviewers need.",
		);
	if (used.some((word) => word === "--web" || word === "-w")) return null;
	let body: string | null = null;
	const fileIndex = create.findIndex(
		(word) => word === "--body-file" || word === "-F",
	);
	if (fileIndex !== -1) {
		const path = create[fileIndex + 1];
		if (!path || path === "-") return null;
		body = readFile(path);
		if (body === null) return null;
	} else if (
		used.some(
			(word) =>
				word === "--body" || word === "-b" || word.startsWith("--body="),
		)
	) {
		// The body is often a heredoc inside $(...), which the word splitter drops, so check the raw line.
		body = line;
	} else return reason("This pull request has no body.");
	const missing = missingSections(body ?? "", sections);
	return missing.length === 0
		? null
		: reason(
				`The body lacks ${missing.map((section) => `"## ${section}"`).join(", ")}.`,
			);
}

const escapeRegex = (text: string) =>
	text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Headings from `sections` missing from a pull request body. */
export function missingSections(body: string, sections: string[]) {
	return sections.filter(
		(section) =>
			// The raw command line puts the first heading right after the opening quote.
			!new RegExp(
				`(?:^|["'=])\\s*#{1,6}\\s*${escapeRegex(section)}\\b`,
				"im",
			).test(body),
	);
}
