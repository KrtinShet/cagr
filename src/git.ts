import { dirname } from "node:path";
import { run } from "./run";

export type GitContext = {
	branch: string | null;
	toplevel: string | null;
	/** The main checkout: the folder holding the shared .git directory. */
	mainCheckout: string | null;
	/** The shared .git directory, absolute. */
	commonDir: string | null;
	head: string | null;
};

export async function gitContext(cwd: string): Promise<GitContext> {
	const [paths, branch] = await Promise.all([
		run(
			[
				"git",
				"rev-parse",
				"--show-toplevel",
				"--path-format=absolute",
				"--git-common-dir",
				"--verify",
				"-q",
				"HEAD",
			],
			cwd,
		),
		run(["git", "symbolic-ref", "--short", "-q", "HEAD"], cwd),
	]);
	// Before the first commit HEAD does not resolve: rev-parse fails but still prints the paths.
	const lines = paths.output.trim().split("\n");
	const [toplevel, commonDir, head] =
		lines[0]?.startsWith("/") || /^[A-Za-z]:/.test(lines[0] ?? "") ? lines : [];
	return {
		branch: branch.ok ? branch.output.trim() || null : null,
		toplevel: toplevel || null,
		mainCheckout: commonDir ? dirname(commonDir) : null,
		commonDir: commonDir || null,
		head: head || null,
	};
}

/** Runs git and returns trimmed stdout, or throws with git's message. */
export async function git(args: string[], cwd: string): Promise<string> {
	const result = await run(["git", ...args], cwd);
	if (!result.ok)
		throw new Error(`git ${args.join(" ")} failed: ${result.output.trim()}`);
	return result.stdout.trim();
}
