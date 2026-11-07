import type { Config } from "../config/schema";
import { programWords, simpleCommands, withoutHeredocBodies } from "../shell";
import type { Finding } from "./finding";
import { packageManagerFinding } from "./package-manager";

const gitOptionsWithValue = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
]);
const pushOptionsWithValue = new Set([
	"--repo",
	"-o",
	"--push-option",
	"--receive-pack",
	"--exec",
]);
// What git may still do in the main checkout: read, and fast-forward the protected branch.
const mainCheckoutGitCommands = new Set([
	"status",
	"log",
	"diff",
	"show",
	"fetch",
	"pull",
	"worktree",
	"branch",
	"rev-parse",
	"remote",
	"config",
	"grep",
	"blame",
	"ls-files",
	"cat-file",
]);

export type CommandContext = {
	branch: string | null;
	/** True when the command runs in the main checkout and worktree_only is on. */
	inMainCheckout: boolean;
};

export const commandReasons = {
	noVerify: () =>
		"--no-verify skips the repo's git hooks. Fix what the hook reports instead.",
	hooksPath: () =>
		"Changing core.hooksPath turns off the repo's git hooks. Fix what the hook reports instead.",
	skipHooks: (config: Config) =>
		`${config.git.skip_env} is for humans only. Fix what the hook reports instead.`,
	forcePush: () =>
		"Force pushes are blocked for agents. Ask a human if history really must be rewritten.",
	pushAll: (config: Config) =>
		`Push one branch at a time. --all and --mirror also push ${config.git.protected_branch}.`,
	pushProtected: (config: Config) =>
		`Do not push to ${config.git.protected_branch}. Push your ${config.git.branch_name?.label ?? "feature"} branch and open a pull request.`,
	mainCheckout: (config: Config) =>
		`The main checkout stays on ${config.git.protected_branch ?? "the default branch"} with a clean tree. Work in a worktree: \`git worktree add ${config.git.worktree_dir}/<name> -b <type>/<name>\`, then cd into it.`,
};

/** Whether the command needs the current branch or checkout to be judged. */
export function needsGitContext(line: string) {
	return simpleCommands(withoutHeredocBodies(line)).some(
		(words) => programWords(words)[0] === "git",
	);
}

export function commandFinding(
	line: string,
	config: Config,
	context: CommandContext,
): Finding | null {
	const commands = simpleCommands(withoutHeredocBodies(line));
	// A `cd` or `git -C` points git elsewhere, and the guard cannot tell where.
	const staysInMainCheckout =
		context.inMainCheckout && !commands.some(([program]) => program === "cd");
	for (const words of commands) {
		const finding = simpleCommandFinding(words, config, {
			...context,
			inMainCheckout: staysInMainCheckout,
		});
		if (finding) return finding;
	}
	return null;
}

function simpleCommandFinding(
	words: string[],
	config: Config,
	context: CommandContext,
): Finding | null {
	const { git } = config;
	if (
		git.block_hook_skips &&
		words.some((word) => word.startsWith(`${git.skip_env}=`))
	)
		return { id: "hook-skip", reason: commandReasons.skipHooks(config) };
	const blocked = config.commands.blocked.find((entry) =>
		containsWords(words, entry.match),
	);
	if (blocked) return { id: "blocked-command", reason: blocked.reason };
	const program = programWords(words);
	const manager = packageManagerFinding(program, config);
	if (manager) return manager;
	if (program[0] !== "git") return null;
	const args = program.slice(1);
	if (context.inMainCheckout && changesMainCheckout(args))
		return { id: "worktree-only", reason: commandReasons.mainCheckout(config) };
	return gitFinding(args, config, context.branch);
}

function gitFinding(
	args: string[],
	config: Config,
	branch: string | null,
): Finding | null {
	const skips = config.git.block_hook_skips;
	let index = 0;
	while (index < args.length && (args[index] as string).startsWith("-")) {
		const option = args[index] as string;
		const value = gitOptionsWithValue.has(option) ? args[index + 1] : undefined;
		if (skips && /core\.hookspath/i.test(`${option} ${value ?? ""}`))
			return { id: "hook-skip", reason: commandReasons.hooksPath() };
		index += value === undefined ? 1 : 2;
	}
	const subcommand = args[index];
	const rest = args.slice(index + 1);

	if (skips) {
		if (rest.includes("--no-verify"))
			return { id: "hook-skip", reason: commandReasons.noVerify() };
		if (subcommand === "commit" && rest.some(isShortFlagGroupWith("n")))
			return { id: "hook-skip", reason: commandReasons.noVerify() };
		if (
			subcommand === "config" &&
			changesHooksPath(rest, config.git.hooks_path)
		)
			return { id: "hook-skip", reason: commandReasons.hooksPath() };
	}
	if (subcommand === "push") return pushFinding(rest, config, branch);
	return null;
}

function pushFinding(
	args: string[],
	config: Config,
	branch: string | null,
): Finding | null {
	const protectedBranch = config.git.protected_branch;
	const positional: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] as string;
		if (
			protectedBranch &&
			(arg === "--all" || arg === "--mirror" || arg === "--branches")
		)
			return { id: "protected-branch", reason: commandReasons.pushAll(config) };
		if (
			config.git.block_force_push &&
			(arg.startsWith("--force") || isShortFlagGroupWith("f")(arg))
		)
			return { id: "force-push", reason: commandReasons.forcePush() };
		if (pushOptionsWithValue.has(arg)) index++;
		else if (!arg.startsWith("-")) positional.push(arg);
	}

	const refspecs = positional.slice(1);
	if (
		config.git.block_force_push &&
		refspecs.some((refspec) => refspec.startsWith("+"))
	)
		return { id: "force-push", reason: commandReasons.forcePush() };
	if (!protectedBranch) return null;
	const targets =
		refspecs.length > 0
			? refspecs.map((refspec) => pushTarget(refspec, branch))
			: [branch];
	return targets.includes(protectedBranch)
		? { id: "protected-branch", reason: commandReasons.pushProtected(config) }
		: null;
}

function pushTarget(refspec: string, branch: string | null): string | null {
	const destination = refspec.includes(":")
		? refspec.slice(refspec.lastIndexOf(":") + 1)
		: refspec;
	const name = destination.replace(/^\+/, "").replace(/^refs\/heads\//, "");
	return name === "HEAD" || name === "@" ? branch : name;
}

/** True when `match`'s words appear in order, next to each other, in `words`. */
export function containsWords(words: string[], match: string) {
	const needle = simpleCommands(match)[0] ?? [];
	if (needle.length === 0) return false;
	for (let start = 0; start + needle.length <= words.length; start++)
		if (needle.every((word, offset) => words[start + offset] === word))
			return true;
	return false;
}

function changesMainCheckout(args: string[]) {
	if (args.includes("-C")) return false;
	const subcommand = args.find((arg) => !arg.startsWith("-"));
	return subcommand !== undefined && !mainCheckoutGitCommands.has(subcommand);
}

// Restoring core.hooksPath to the configured folder is how the hooks get turned on, so it is allowed.
function changesHooksPath(args: string[], hooksPath: string) {
	const keyIndex = args.findIndex(
		(arg) => arg.toLowerCase() === "core.hookspath",
	);
	if (keyIndex === -1) return false;
	if (args.some((arg) => arg.startsWith("--unset"))) return true;
	const value = args[keyIndex + 1];
	return value !== undefined && value !== hooksPath;
}

function isShortFlagGroupWith(flag: string) {
	return (arg: string) => /^-[A-Za-z]+$/.test(arg) && arg.includes(flag);
}
