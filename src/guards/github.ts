import type { Config } from "../config/schema";
import { programWords, simpleCommands, withoutHeredocBodies } from "../shell";
import { containsWords } from "./command";
import type { Finding } from "./finding";

const commandsOf = (line: string) =>
	simpleCommands(withoutHeredocBodies(line)).map(programWords);

/** gh flags that come before the subcommand and take a value. */
const ghValueFlags = new Set(["-R", "--repo", "--hostname"]);
/** gh's built-in aliases, which reach the same command under another name. */
const ghAliases: Record<string, Record<string, string>> = {
	pr: { new: "create" },
};

/**
 * The words of a gh call with flags before the subcommand dropped and built-in
 * aliases expanded, so `gh -R o/r pr new` reads as `gh pr create`.
 */
export function ghWords(words: string[]): string[] | null {
	if (words[0] !== "gh") return null;
	const out = ["gh"];
	let index = 1;
	while (out.length < 3 && index < words.length) {
		const word = words[index++] as string;
		if (!word.startsWith("-")) out.push(word);
		else if (ghValueFlags.has(word)) index++;
	}
	const [, group, action] = out;
	const alias = group && action ? ghAliases[group]?.[action] : undefined;
	if (alias) out[2] = alias;
	return [...out, ...words.slice(index)];
}

const ghCommandsOf = (line: string) =>
	commandsOf(line)
		.map(ghWords)
		.filter((words) => words !== null);

const mergeApi =
	/\/pulls\/[^/\s]+\/merge\b|\/merges\b|mergePullRequest|enablePullRequestAutoMerge/;
const reviewApi =
	/\/pulls\/[^/\s]+\/reviews\b|addPullRequestReview|submitPullRequestReview/;
const resolveApi = /resolveReviewThread/;
const createApi = /createPullRequest\b/;
const readyApi = /markPullRequestReadyForReview\b/;
// gh api sends a POST when it is given fields or a body.
const restCreate =
	/repos\/[^/\s]+\/[^/\s]+\/pulls(?![/\w])[\s\S]*(?:\s-[fF]\s|\s--(?:raw-)?field\b|\s--input\b|-X\s*POST|--method[\s=]*POST)/i;

export const githubReasons = {
	merge: () =>
		"Agents do not merge pull requests here. Say the pull request is ready and let a person review and merge it.",
	approve: () =>
		"An agent's approval does not count here. Leave a comment with `gh pr review --comment` if you need to, and let a person approve.",
	resolve: () =>
		"Agents do not resolve review threads here: a resolved thread counts as an answer to the finding. Fix the finding, or reply on the thread saying why it is wrong, and let a person resolve it.",
	alias: () =>
		"Agents do not set gh aliases for merging, approving, resolving threads or opening pull requests here. Run the gh command itself.",
};

const approves = (word: string) =>
	word === "--approve" ||
	word.startsWith("--approve=") ||
	/^-[a-zA-Z]*a[a-zA-Z]*$/.test(word);

/** `gh pr merge`, `gh pr review --approve` and the merge or review API, when agents may not merge. */
export function agentApprovalFinding(
	line: string,
	config: Config,
): Finding | null {
	const merge = !config.review.agents_may_merge;
	const finding = (reason: string) => ({ id: "agent-approval", reason });
	for (const words of ghCommandsOf(line)) {
		const [, group, action] = words;
		if (group === "alias" && (action === "set" || action === "import")) {
			if (action === "import" || aliasIsGuarded(words.slice(3), config))
				return finding(githubReasons.alias());
			continue;
		}
		if (merge && group === "pr" && action === "merge")
			return finding(githubReasons.merge());
		if (
			merge &&
			group === "pr" &&
			action === "review" &&
			words.slice(3).some(approves)
		)
			return finding(githubReasons.approve());
		// The API can do all of these, so read the whole line: the path or the GraphQL mutation may sit in quotes.
		if (group !== "api") continue;
		if (merge && mergeApi.test(line)) return finding(githubReasons.merge());
		if (merge && reviewApi.test(line) && /APPROVE/.test(line))
			return finding(githubReasons.approve());
		if (config.review.enabled && resolveApi.test(line))
			return finding(githubReasons.resolve());
	}
	return null;
}

/** Whether `gh alias set <name> <expansion>` would name a command agents may not run or must be gated. */
function aliasIsGuarded(args: string[], config: Config) {
	const shell = args.some((arg) => arg === "--shell" || arg === "-s");
	const expansion = args.filter((arg) => !arg.startsWith("-"))[1];
	if (expansion === undefined) return false;
	const asLine = shell ? expansion : `gh ${expansion}`;
	return (
		agentApprovalFinding(asLine, config) !== null ||
		isGateCommand(asLine, config)
	);
}

/** Whether the line runs one of the [review] gate commands, under any spelling gh accepts. */
export function isGateCommand(line: string, config: Config) {
	if (!config.review.enabled || config.review.gate.length === 0) return false;
	const gates = (what: string) =>
		config.review.gate.some((match) => match.includes(what));
	return commandsOf(line).some((raw) => {
		const words = ghWords(raw) ?? raw;
		if (config.review.gate.some((match) => containsWords(words, match)))
			return true;
		if (words[0] !== "gh" || words[1] !== "api") return false;
		return (
			(gates("pr create") && (createApi.test(line) || restCreate.test(line))) ||
			(gates("pr ready") && readyApi.test(line))
		);
	});
}

/** The branch a `gh pr create` names with --head, without an `owner:` prefix. */
export function prHeadBranch(line: string): string | null {
	for (const words of ghCommandsOf(line)) {
		if (words[1] !== "pr" || words[2] !== "create") continue;
		for (const [index, word] of words.entries()) {
			const value =
				word === "--head" || word === "-H"
					? words[index + 1]
					: word.startsWith("--head=")
						? word.slice("--head=".length)
						: undefined;
			if (value) return value.replace(/^[^:]+:/, "");
		}
	}
	return null;
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
	const create = ghCommandsOf(line).find(
		(words) => words[1] === "pr" && words[2] === "create",
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
