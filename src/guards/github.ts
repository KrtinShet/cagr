import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Config } from "../config/schema";
import {
	commandsWithNesting,
	programName,
	programWords,
	simpleCommands,
	withoutHeredocBodies,
} from "../shell";
import { containsWords, gitOptionsWithValue } from "./command";
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
	if (programName(words) !== "gh") return null;
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
// gh api also takes a full URL, on github.com or on GitHub Enterprise under /api/v3.
const pullsEndpoint =
	/^(?:https?:\/\/[^/]+(?:\/api\/v3)?)?\/?repos\/[^/]+\/[^/]+\/pulls\/?(?:\?.*)?$/i;
// Short flags may be attached to their value (`-ftitle=x`) or follow gh api's one boolean short flag, -i.
const fieldFlag = /^(?:-i*[fF]|--(?:raw-)?field\b|--input\b)/;
const methodFlag = /^(?:-i*X|--method=?)(.*)$/;

/** The HTTP method a `gh api` call sends: -X wins, else POST when it has fields or a body. */
function apiMethod(args: string[]) {
	let method: string | null = null;
	let fields = false;
	for (const [index, word] of args.entries()) {
		const flag = word.match(methodFlag);
		if (flag) method = flag[1] || (args[index + 1] ?? "");
		else if (fieldFlag.test(word)) fields = true;
	}
	return (method ?? (fields ? "POST" : "GET")).toUpperCase();
}

/** Whether the words of a `gh api` call POST to the REST pulls endpoint, with the flags in any order. */
const restCreate = (args: string[]) =>
	args.some((word) => pullsEndpoint.test(word)) && apiMethod(args) === "POST";

export const githubReasons = {
	merge: () =>
		"Agents do not merge pull requests here. Say the pull request is ready and let a person review and merge it.",
	approve: () =>
		"An agent's approval does not count here. Leave a comment with `gh pr review --comment` if you need to, and let a person approve.",
	resolve: () =>
		"Agents do not resolve review threads here: a resolved thread counts as an answer to the finding. Fix the finding, or reply on the thread saying why it is wrong, and let a person resolve it.",
	alias: () =>
		"Agents do not set gh aliases for merging, approving, resolving threads or opening pull requests here. Run the gh command itself.",
	readyByNumber: (target: string) =>
		`\`gh pr ready ${target}\` names a pull request by number or URL, so cagr cannot tell which branch's review to check. Check out the pull request's branch and run \`gh pr ready\` there with no argument.`,
	readyById: () =>
		"This `gh api` call marks a pull request ready by its id, so cagr cannot tell which branch's review to check. Check out the pull request's branch and run `gh pr ready` there with no argument.",
	otherHead: (head: string, current: string | null) =>
		`This \`gh api\` call opens a pull request from ${head}, not from the checked-out branch${current ? ` ${current}` : ""}, so cagr cannot check its review. Check out ${head}, run \`cagr review\` there, and open the pull request with \`gh pr create\` with no --head.`,
	unknownHead: () =>
		"cagr cannot tell which branch this `gh api` call opens a pull request from, so it cannot check the review. Check out the branch and open the pull request with `gh pr create`.",
	order: (before: string, gate: string) =>
		`This line runs ${before} before \`${gate}\`. cagr checks the review before the line runs, so before a gate command it allows only \`git add\`, \`git push\`, \`git status\`, \`git fetch\`, \`git diff\`, \`git log\`, and one \`cd <path> &&\` at the start. Run that first, then run \`${gate}\` as a command of its own.`,
	cd: () =>
		"This line starts with a `cd` or `pushd` that cagr cannot follow: it has `$`, a backtick, a glob, `-` or `~user`, or is not followed by `&&`. Start the line with `cd <literal path> &&`, or run the gate command from that folder on its own.",
	manyBranches: () =>
		"This line opens or readies pull requests for more than one branch, and cagr checks one branch's review at a time. Run each gate command on its own, from its branch.",
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

/** The words of `raw`, normalized as ghWords does, when it runs one of the [review] gate commands. */
function gateWords(raw: string[], line: string, config: Config) {
	const words = ghWords(raw) ?? [programName(raw), ...raw.slice(1)];
	if (config.review.gate.some((match) => containsWords(words, match)))
		return words;
	if (words[0] !== "gh" || words[1] !== "api") return null;
	const gates = (what: string) =>
		config.review.gate.some((match) => match.includes(what));
	return (gates("pr create") &&
		(createApi.test(line) || restCreate(raw.slice(1)))) ||
		(gates("pr ready") && readyApi.test(line))
		? words
		: null;
}

const gateCommandsOf = (line: string, config: Config) =>
	config.review.enabled && config.review.gate.length > 0
		? commandsOf(line).flatMap((raw) => {
				const words = gateWords(raw, line, config);
				return words ? [{ raw, words }] : [];
			})
		: [];

/** Whether the line runs one of the [review] gate commands, under any spelling gh accepts. */
export function isGateCommand(line: string, config: Config) {
	return gateCommandsOf(line, config).length > 0;
}

const withoutOwner = (branch: string) => branch.replace(/^[^:]+:/, "");

/** The value of `gh pr create --head`, `-H` or `--head=`, if given. The last one wins, as in gh. */
function headFlag(words: string[]) {
	let head: string | null = null;
	for (const [index, word] of words.entries()) {
		const value =
			word === "--head" || word === "-H"
				? words[index + 1]
				: word.startsWith("--head=")
					? word.slice("--head=".length)
					: /^-H./.test(word)
						? word.slice(2)
						: undefined;
		if (value) head = withoutOwner(value);
	}
	return head;
}

/** The branch a `gh pr create` names with --head, without an `owner:` prefix. */
export function prHeadBranch(line: string): string | null {
	for (const words of ghCommandsOf(line))
		if (words[1] === "pr" && words[2] === "create") return headFlag(words);
	return null;
}

/** The first argument that is not a flag, skipping the values of -R and --repo. */
function positional(args: string[]) {
	for (let index = 0; index < args.length; index++) {
		const word = args[index] as string;
		if (ghValueFlags.has(word)) index++;
		else if (!word.startsWith("-")) return word;
	}
	return undefined;
}

/** The `-f name=value` fields of a `gh api` call, in every spelling gh accepts. */
function apiFields(args: string[]) {
	const fields = new Map<string, string>();
	for (let index = 0; index < args.length; index++) {
		const word = args[index] as string;
		const attached = word.match(/^(?:-i*[fF]|--(?:raw-)?field=)(.+)$/);
		const pair = attached
			? attached[1]
			: /^(?:-i*[fF]|--(?:raw-)?field)$/.test(word)
				? args[++index]
				: undefined;
		const split = pair?.indexOf("=") ?? -1;
		if (pair && split > 0)
			fields.set(pair.slice(0, split), pair.slice(split + 1));
	}
	return fields;
}

const inputIndex = (args: string[]) =>
	args.findLastIndex(
		(word) => word === "--input" || word.startsWith("--input="),
	);

/** The `head` of the JSON body given with --input, when it is a file cagr can read. */
function inputHead(
	args: string[],
	index: number,
	readFile: (path: string) => string | null,
) {
	const word = args[index] as string;
	const path = word.includes("=")
		? word.slice(word.indexOf("=") + 1)
		: args[index + 1];
	if (!path || path === "-") return undefined;
	try {
		const head = JSON.parse(readFile(path) ?? "").head;
		return typeof head === "string" ? head : undefined;
	} catch {
		return undefined;
	}
}

/** The branch a `gh api` call opens a pull request from, if cagr can tell. */
function apiHead(
	raw: string[],
	line: string,
	readFile: (path: string) => string | null,
) {
	const args = raw.slice(1);
	const input = inputIndex(args);
	// With --input, gh sends the fields as query parameters and the body comes from the file.
	if (input !== -1)
		return createApi.test(line) ? undefined : inputHead(args, input, readFile);
	const fields = apiFields(args);
	if (!createApi.test(line)) return fields.get("head");
	const literal = line.match(/headRefName\s*:\s*\\?"([^"\\]+)/);
	if (literal) return literal[1];
	const variable = line.match(/headRefName\s*:\s*\$(\w+)/)?.[1];
	return variable ? fields.get(variable) : undefined;
}

// What may run before a gate command on the same line: none of these moves HEAD or the folder.
const allowedBeforeGate = new Set([
	"add",
	"push",
	"status",
	"fetch",
	"diff",
	"log",
]);
// One literal `cd <path> &&` at the very start. `;` or `||` would run the gate command even when the cd fails.
const leadingCd =
	/^\s*(?:cd|pushd)\s+(?:'([^']*)'|"([^"$`\\]*)"|([^\s;&|()<>`$'"\\*?[\]{}]+))\s*&&/;

/** The git subcommand, after git's own options. */
function gitSubcommand(words: string[]) {
	let index = 1;
	while ((words[index] ?? "").startsWith("-"))
		index += gitOptionsWithValue.has(words[index] as string) ? 2 : 1;
	return words[index];
}

/** How a message names a command that may not run before a gate command. */
function commandName(words: string[], nested: boolean) {
	if (nested) return "a subshell";
	const program = programName(words);
	const gh = ghWords(words);
	const name =
		program === "git"
			? `git ${gitSubcommand(words) ?? ""}`.trim()
			: gh
				? gh.slice(0, 3).join(" ")
				: words[1]?.startsWith("-")
					? `${program} ${words[1]}`
					: program;
	return `\`${name}\``;
}

const isAllowedBeforeGate = (words: string[]) =>
	programName(words) === "git" &&
	allowedBeforeGate.has(gitSubcommand(words) ?? "");

/** Where a literal `cd` target goes, or null for `-` and `~user`. */
function cdTarget(target: string, cwd: string) {
	if (target === "~") return homedir();
	if (target.startsWith("~/")) return join(homedir(), target.slice(2));
	if (target === "-" || target.startsWith("~")) return null;
	return resolve(cwd, target);
}

export type GatePlan = { dir: string } | { finding: Finding };

/**
 * The folder to run the review gate in for a line with a gate command, or a
 * finding when something before the gate command could move HEAD or the
 * folder. The gate reads HEAD before the line runs, so only commands that
 * leave both alone may come first.
 */
export function gatePlan(line: string, config: Config, cwd: string): GatePlan {
	const text = withoutHeredocBodies(line);
	const deny = (reason: string): GatePlan => ({
		finding: { id: "review-gate", reason },
	});
	let dir = cwd;
	let rest = text;
	const first = commandsOf(text)[0];
	if (first && ["cd", "pushd", "popd"].includes(programName(first))) {
		const match = text.match(leadingCd);
		const target = match && (match[1] ?? match[2] ?? match[3] ?? "");
		const resolved = target ? cdTarget(target, cwd) : null;
		if (!match || !resolved) return deny(githubReasons.cd());
		dir = resolved;
		rest = text.slice(match[0].length);
	}
	let blocker: string | null = null;
	for (const { words: raw, nested } of commandsWithNesting(rest)) {
		const words = programWords(raw);
		const gate = gateWords(words, line, config);
		if (gate) {
			if (blocker)
				return deny(
					githubReasons.order(
						blocker,
						config.review.gate.find((match) => containsWords(gate, match)) ??
							"gh api",
					),
				);
			continue;
		}
		if (!blocker && (nested || !isAllowedBeforeGate(words)))
			blocker = commandName(words, nested);
	}
	return { dir };
}

export type GateTarget = { branch: string | null } | { reason: string };

/** The branch one gate command acts on: null for the checked-out one. */
function commandTarget(
	gate: { raw: string[]; words: string[] },
	line: string,
	current: string | null,
	readFile: (path: string) => string | null,
): GateTarget {
	const { raw, words } = gate;
	if (words[1] === "pr" && words[2] === "create")
		return { branch: headFlag(words) };
	if (words[1] === "pr" && words[2] === "ready") {
		const target = positional(words.slice(3));
		if (target === undefined) return { branch: null };
		if (/^#?\d+$|^https?:\/\/|\/pull\/\d/i.test(target))
			return { reason: githubReasons.readyByNumber(target) };
		return { branch: withoutOwner(target) };
	}
	if (words[1] !== "api") return { branch: null };
	if (readyApi.test(line)) return { reason: githubReasons.readyById() };
	const head = apiHead(raw, line, readFile);
	if (head === undefined) return { reason: githubReasons.unknownHead() };
	const branch = withoutOwner(head);
	return branch === current
		? { branch: null }
		: { reason: githubReasons.otherHead(branch, current) };
}

/**
 * The branch whose review the gate checks for this line: null for the
 * checked-out branch, or a reason to deny when cagr cannot tell.
 */
export function gateTarget(
	line: string,
	config: Config,
	current: string | null,
	readFile: (path: string) => string | null,
): GateTarget {
	let named: string | null = null;
	const branches = new Set<string | null>();
	for (const gate of gateCommandsOf(line, config)) {
		const target = commandTarget(gate, line, current, readFile);
		if ("reason" in target) return target;
		named ??= target.branch;
		branches.add(target.branch ?? current);
	}
	if (branches.size > 1) return { reason: githubReasons.manyBranches() };
	return { branch: named };
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

// `--body=x`, `-bx`, `--body-file=x` and `-Fx`: gh accepts a value attached to its flag.
const attachedBody = /^(?:--body(?:-file)?=|-[bF].)/;

/** The path `gh pr create` reads its body from, if it names one. */
function bodyFile(words: string[]): string | undefined {
	for (const [index, word] of words.entries()) {
		if (word === "--body-file" || word === "-F") return words[index + 1] ?? "";
		if (word.startsWith("--body-file="))
			return word.slice("--body-file=".length);
		if (/^-F./.test(word)) return word.slice(2);
	}
	return undefined;
}

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
		(word) => bodyFlags.has(word) || attachedBody.test(word),
	);
	if (used.some((word) => word.startsWith("--fill") || word === "-f"))
		return reason(
			"--fill writes the body from commits, without the sections reviewers need.",
		);
	if (used.some((word) => word === "--web" || word === "-w")) return null;
	let body: string | null = null;
	const path = bodyFile(create);
	if (path !== undefined) {
		if (!path || path === "-") return null;
		body = readFile(path);
		if (body === null) return null;
	} else if (
		used.some(
			(word) => word === "--body" || word === "-b" || attachedBody.test(word),
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
