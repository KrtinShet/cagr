import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config/schema";
import { formatLayout, layoutFindings } from "./rules/layout";
import {
	findInFiles,
	formatFinding,
	loadRules,
	RuleError,
} from "./rules/rules";

/** Every file git tracks or would track (not ignored) that is on disk, repo-relative. Null outside a git repo. */
export function repoFiles(root: string): string[] | null {
	const listed = Bun.spawnSync(
		["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
		{ cwd: root, stdout: "pipe", stderr: "ignore" },
	);
	if (listed.exitCode !== 0) return null;
	const paths = listed.stdout
		.toString()
		.split("\0")
		.filter((path) => path !== "" && existsSync(join(root, path)));
	return [...new Set(paths)].sort();
}

/**
 * Runs the code rules and layout rules over every file, for a repo moving an
 * existing checker into cagr. It leaves out the `on_edit` commands, which may
 * change files and run once per stack anyway in `verify`.
 */
export async function checkAll(
	config: Config,
): Promise<{ ok: boolean; report: string }> {
	const paths = repoFiles(config.root);
	if (paths === null)
		return {
			ok: false,
			report:
				"cagr check --all lists files with git, and this folder is not a git repo. Run `git init`, or name the files: cagr check <files...>",
		};
	const sections: string[] = [];
	try {
		const rules = loadRules(config);
		const findings = await findInFiles(
			rules,
			paths.map((path) => join(config.root, path)),
			config.root,
		);
		if (findings.length > 0)
			sections.push(`## Rules\n${findings.map(formatFinding).join("\n")}`);
	} catch (error) {
		if (!(error instanceof RuleError)) throw error;
		sections.push(`## Rules\n${error.message}`);
	}
	const layout = layoutFindings(config.layout, paths);
	if (layout.length > 0)
		sections.push(`## Layout\n${layout.map(formatLayout).join("\n")}`);
	if (sections.length > 0) return { ok: false, report: sections.join("\n\n") };
	return {
		ok: true,
		report: `No problems in ${paths.length} file${paths.length === 1 ? "" : "s"}.`,
	};
}
