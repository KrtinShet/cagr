import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config/schema";
import { gitContext } from "./git";
import { missingSections } from "./guards/github";
import { branchFinding, commitMessageFinding } from "./guards/names";
import { stackFiles, tidy, withFiles } from "./hook/stack-files";
import { resolveBase } from "./review/review";
import { classify, riskReport } from "./risk";
import { findInFiles, loadRules, RuleError } from "./rules/rules";
import { run, runShell } from "./run";
import { sync } from "./sync";

export type Annotation = { file?: string; line?: number; message: string };
export type CiCheck = {
	name: string;
	ok: boolean;
	output: string;
	annotations: Annotation[];
};
export type CiResult = { ok: boolean; checks: CiCheck[]; tier: string };

const check = (
	name: string,
	problems: string[],
	annotations: Annotation[] = [],
): CiCheck => ({
	name,
	ok: problems.length === 0,
	output: problems.join("\n"),
	annotations,
});

async function out(argv: string[], cwd: string) {
	const result = await run(argv, cwd);
	if (!result.ok)
		throw new Error(`${argv.join(" ")} failed: ${result.output.trim()}`);
	return result.output.trimEnd();
}

/**
 * The same checks the agent hooks and git hooks ran, for a branch in CI, so a
 * change made without the hooks cannot merge.
 */
export async function ci(
	config: Config,
	options: {
		cwd: string;
		base?: string;
		env?: Record<string, string | undefined>;
	},
): Promise<CiResult> {
	const env = options.env ?? process.env;
	const git = await gitContext(options.cwd);
	const cwd = git.toplevel ?? options.cwd;
	const baseName =
		options.base ??
		env.GITHUB_BASE_REF ??
		config.git.protected_branch ??
		"main";
	const baseRef = await resolveBase(baseName, cwd);
	const mergeBase = await out(["git", "merge-base", baseRef, "HEAD"], cwd);
	const changed = (
		await out(
			["git", "diff", "--name-only", "--diff-filter=d", mergeBase, "HEAD"],
			cwd,
		)
	)
		.split("\n")
		.filter(Boolean);
	const absolute = changed
		.map((path) => join(cwd, path))
		.filter((file) => existsSync(file));
	const checks: CiCheck[] = [];

	const drift = sync(config, { check: true }).drifted;
	checks.push(
		check(
			"Generated files",
			drift.map(
				(file) =>
					`${file} is out of date. Run \`guardwright sync\` and commit.`,
			),
		),
	);

	const branch = env.GITHUB_HEAD_REF || git.branch;
	const branchProblem = branch ? branchFinding(branch, config) : null;
	checks.push(
		check("Branch name", branchProblem ? [branchProblem.reason] : []),
	);

	const subjects = (
		await out(
			["git", "log", "--no-merges", "--format=%h %s", `${mergeBase}..HEAD`],
			cwd,
		)
	)
		.split("\n")
		.filter(Boolean);
	checks.push(
		check(
			"Commit messages",
			subjects.flatMap((line) => {
				const finding = commitMessageFinding(
					line.slice(line.indexOf(" ") + 1),
					config,
				);
				return finding ? [`${line.split(" ")[0]}: ${finding.reason}`] : [];
			}),
		),
	);

	const editProblems: string[] = [];
	for (const stack of config.stack) {
		const paths = stackFiles(stack, absolute, config);
		if (paths.length === 0) continue;
		for (const command of stack.on_edit) {
			const result = await runShell(withFiles(command, paths), cwd, {
				timeoutMs: 300_000,
			});
			if (!result.ok)
				editProblems.push(`${command}\n${tidy(result.output, 4000)}`);
		}
	}
	const touched = await out(
		["git", "status", "--porcelain", "--untracked-files=no"],
		cwd,
	);
	if (touched)
		editProblems.push(
			`The edit checks changed files, so the branch was not formatted or fixed before commit. Run the checks locally (\`guardwright check <files>\`) and commit:\n${touched}`,
		);
	checks.push(check("Edit checks", editProblems));

	const commands = new Map<string, string[]>();
	for (const stack of config.stack) {
		const paths = stackFiles(stack, absolute, config);
		for (const command of stack.on_turn_end)
			commands.set(command, [...(commands.get(command) ?? []), ...paths]);
	}
	const endProblems: string[] = [];
	for (const [command, paths] of commands) {
		if (command.includes("{files}") && paths.length === 0) continue;
		const result = await runShell(withFiles(command, paths), cwd, {
			timeoutMs: 1_800_000,
		});
		if (!result.ok)
			endProblems.push(`${command}\n${tidy(result.output, 4000)}`);
	}
	checks.push(check("Checks", endProblems));

	try {
		const findings = await findInFiles(
			loadRules(config),
			absolute,
			config.root,
		);
		checks.push(
			check(
				"Code rules",
				findings.map(
					(finding) =>
						`${finding.path}:${finding.line} ${finding.rule}: ${finding.message} Instead: ${finding.instead}`,
				),
				findings.map((finding) => ({
					file: finding.path,
					line: finding.line,
					message: `${finding.rule}: ${finding.message} Instead: ${finding.instead}`,
				})),
			),
		);
	} catch (error) {
		if (!(error instanceof RuleError)) throw error;
		checks.push(check("Code rules", [error.message]));
	}

	const risk = classify(changed, config);
	checks.push({
		name: "Risk",
		ok: true,
		output: riskReport(risk),
		annotations: [],
	});

	const body = pullRequestBody(env);
	if (body !== null && config.review.pr_sections.length > 0) {
		const missing = missingSections(body, config.review.pr_sections);
		checks.push(
			check(
				"Pull request body",
				missing.length > 0
					? [
							`The description lacks ${missing.map((section) => `"## ${section}"`).join(", ")}. Edit it and fill them in.`,
						]
					: [],
			),
		);
	}
	return { ok: checks.every((entry) => entry.ok), checks, tier: risk.tier };
}

function pullRequestBody(
	env: Record<string, string | undefined>,
): string | null {
	if (!env.GITHUB_EVENT_PATH) return null;
	try {
		const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) as {
			pull_request?: { body: string | null };
		};
		return event.pull_request ? (event.pull_request.body ?? "") : null;
	} catch {
		return null;
	}
}

const escapeData = (text: string) =>
	text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (text: string) =>
	escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");

/** GitHub workflow commands: errors on the lines they are about, or on the run. */
export function annotations(result: CiResult): string[] {
	return result.checks
		.filter((entry) => !entry.ok)
		.flatMap((entry) =>
			entry.annotations.length > 0
				? entry.annotations.map(
						(note) =>
							`::error ${note.file ? `file=${escapeProperty(note.file)}${note.line ? `,line=${note.line}` : ""},` : ""}title=${escapeProperty(entry.name)}::${escapeData(note.message)}`,
					)
				: [
						`::error title=${escapeProperty(entry.name)}::${escapeData(entry.output)}`,
					],
		);
}

export function ciReport(result: CiResult): string {
	return result.checks
		.map(
			(entry) =>
				`${entry.ok ? "PASS" : "FAIL"} ${entry.name}${entry.output ? `\n${entry.output.replace(/^/gm, "  ")}` : ""}`,
		)
		.join("\n");
}

export function summary(result: CiResult) {
	const rows = result.checks.map(
		(entry) => `| ${entry.ok ? "pass" : "**fail**"} | ${entry.name} |`,
	);
	const failed = result.checks.filter((entry) => !entry.ok);
	return [
		`## guardwright: ${result.ok ? "all checks pass" : `${failed.length} check${failed.length === 1 ? "" : "s"} failed`}`,
		"",
		`Risk tier: **${result.tier}**`,
		"",
		"| Result | Check |",
		"| --- | --- |",
		...rows,
		...failed.map(
			(entry) => `\n### ${entry.name}\n\n\`\`\`\n${entry.output}\n\`\`\``,
		),
	].join("\n");
}

/** Writes the step summary and the risk tier output when running in GitHub Actions. */
export function publish(
	result: CiResult,
	env: Record<string, string | undefined> = process.env,
) {
	if (env.GITHUB_STEP_SUMMARY)
		appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary(result)}\n`);
	if (env.GITHUB_OUTPUT)
		appendFileSync(env.GITHUB_OUTPUT, `tier=${result.tier}\n`);
}
