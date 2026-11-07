import { dirname } from "node:path";
import { run } from "./run";

export type GitContext = {
	branch: string | null;
	toplevel: string | null;
	/** The main checkout: the folder holding the shared .git directory. */
	mainCheckout: string | null;
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
			],
			cwd,
		),
		run(["git", "symbolic-ref", "--short", "-q", "HEAD"], cwd),
	]);
	const [toplevel, commonDir] = paths.ok ? paths.output.trim().split("\n") : [];
	return {
		branch: branch.ok ? branch.output.trim() || null : null,
		toplevel: toplevel || null,
		mainCheckout: commonDir ? dirname(commonDir) : null,
	};
}
