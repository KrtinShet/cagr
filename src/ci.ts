import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { runAdmittedShell } from "./admission/run";
import { checkChanges } from "./changes/check";
import type { Config } from "./config/schema";
import { gitContext } from "./git";
import { gitEnv } from "./git-hooks";
import { missingSections } from "./guards/github";
import { checkSuppressions } from "./guards/lint-suppression";
import { branchFinding, commitMessageFinding } from "./guards/names";
import { stackFiles, tidy, withFiles } from "./hook/stack-files";
import { classify, riskReport } from "./risk";
import { type LayoutRule, layoutFindings } from "./rules/layout";
import { findInFiles, loadRuleSet, RuleError } from "./rules/rules";
import { type RunOptions, type RunResult, run, type runShell } from "./run";
import { SyncError, sync } from "./sync";

export type Annotation = { file?: string; line?: number; message: string };
export type CiCheck = {
	name: string;
	ok: boolean;
	output: string;
	annotations: Annotation[];
	deferred?: boolean;
};
export type CiResult = { ok: boolean; checks: CiCheck[]; tier: string };

type PullRequest = {
	head?: { sha: string };
	title?: unknown;
	body?: string | null;
};

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
	return result.stdout.trimEnd();
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
		pr?: PullRequest & { branch: string };
		runCheck?: typeof runShell;
		executeCheck?: typeof run;
		env?: Record<string, string | undefined>;
	},
): Promise<CiResult> {
	const env = options.env ?? process.env;
	const runCheck =
		options.runCheck ??
		(async (
			command: string,
			cwd: string,
			runOptions: RunOptions,
		): Promise<RunResult> => {
			try {
				return await runAdmittedShell(command, cwd, config.admission, {
					...runOptions,
					execute: options.executeCheck,
					log: console.error,
				});
			} catch (error) {
				return {
					ok: false,
					admission: "deferred",
					stdout: "",
					ms: 0,
					timedOut: false,
					output: `cagr could not run the check. ${error} Rerun cagr ci to verify this command.`,
				};
			}
		});
	const git = await gitContext(options.cwd);
	const cwd = config.root;
	const baseName =
		// Actions sets GITHUB_BASE_REF to "" outside pull requests, as on merge_group.
		options.base ||
		env.GITHUB_BASE_REF ||
		config.git.protected_branch ||
		"main";
	const changeResult = await checkChanges(config, {
		base: baseName,
		committed: true,
	});
	const checks: CiCheck[] = [
		check(
			"Change rules",
			changeResult.ok ? [] : [changeResult.output],
			changeResult.findings.map((f) => ({
				file: f.path,
				message: `${f.message} Instead: ${f.reason}`,
			})),
		),
	];
	if (!changeResult.snapshot)
		return { ok: false, checks, tier: config.risk.default };
	const mergeBase = changeResult.snapshot.base;
	const changed = changeResult.snapshot.changes
		.filter((c) => c.status !== "D")
		.map((c) => c.path);
	const absolute = changed.map((path) => join(cwd, path)).filter(existsSync);
	const dirty = await out(["git", "status", "--porcelain", "-z"], cwd);
	checks.push(
		check(
			"Clean checkout",
			dirty
				? [
						"Checkout is dirty. Commit the intended files and rerun cagr ci in a clean checkout.",
					]
				: [],
		),
	);
	let pullRequest: PullRequest | undefined = options.pr;
	if (!pullRequest && env.GITHUB_EVENT_PATH) {
		try {
			const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) as {
				pull_request?: PullRequest;
			};
			pullRequest = event.pull_request;
		} catch {
			checks.push(
				check("PR head", [
					"Unchecked: could not read the GitHub event. Restore readable valid event JSON and rerun cagr ci.",
				]),
			);
		}
	}
	if (pullRequest && pullRequest.head?.sha !== changeResult.snapshot.head)
		checks.push(
			check("PR head", [
				"Check out the exact pull request head SHA and rerun cagr ci.",
			]),
		);
	try {
		const suppressions = await checkSuppressions(
			config,
			absolute,
			mergeBase,
			"HEAD",
		);
		checks.push(
			check(
				"Lint suppressions",
				suppressions.map((finding) => finding.reason),
				suppressions.map((finding) => ({
					file: finding.file,
					line: finding.line,
					message: finding.reason,
				})),
			),
		);
	} catch (error) {
		checks.push(
			check("Lint suppressions", [
				`Could not check suppressions: ${error instanceof Error ? error.message : String(error)}. Fix the check error and rerun cagr ci.`,
			]),
		);
	}

	let drift: string[];
	try {
		drift = sync(config, { check: true }).drifted.map(
			(file) => `${file} is out of date. Run \`cagr sync\` and commit.`,
		);
	} catch (error) {
		if (!(error instanceof SyncError)) throw error;
		drift = [error.message];
	}
	checks.push(check("Generated files", drift));

	const branch = options.pr?.branch || env.GITHUB_HEAD_REF || git.branch;
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
	if (pullRequest && config.git.commit_message) {
		const title = pullRequest.title;
		if (typeof title !== "string") {
			checks.push(
				check("Pull request title", [
					"Could not read the pull request title. Restore valid pull request event JSON and rerun cagr ci.",
				]),
			);
		} else {
			const finding = commitMessageFinding(title, config, "Pull request title");
			checks.push(
				check(
					"Pull request title",
					finding
						? [
								`${finding.reason} Set a title that matches the rule with \`gh pr edit --title "<new title>"\`.`,
							]
						: [],
				),
			);
		}
	}

	const editProblems: string[] = [];
	const editDeferred: string[] = [];
	for (const stack of config.stack) {
		const paths = stackFiles(stack, absolute, config);
		if (paths.length === 0) continue;
		for (const command of stack.on_edit) {
			const result = await runCheck(withFiles(command, paths), cwd, {
				timeoutMs: 300_000,
			});
			if (!result.ok)
				(result.admission ? editDeferred : editProblems).push(
					`${command}\n${tidy(result.output, 4000)}`,
				);
		}
	}
	const touched = await out(
		["git", "status", "--porcelain", "--untracked-files=no"],
		cwd,
	);
	if (touched)
		editProblems.push(
			`The edit checks changed files, so the branch was not formatted or fixed before commit. Run the checks locally (\`cagr check <files>\`) and commit:\n${touched}`,
		);
	pushScheduledCheck(checks, "Edit checks", editProblems, editDeferred);

	const verifyCommands = config.git.pre_push.filter((command) =>
		command.trim(),
	);
	const verifyOptions = { timeoutMs: 1_800_000, env: gitEnv };
	const turnEndResults = new Map<string, RunResult>();
	const commands = new Map<string, string[]>();
	for (const stack of config.stack) {
		const paths = stackFiles(stack, absolute, config);
		for (const command of stack.on_turn_end)
			commands.set(command, [...(commands.get(command) ?? []), ...paths]);
	}
	const endProblems: string[] = [];
	const endDeferred: string[] = [];
	for (const [command, paths] of commands) {
		if (command.includes("{files}") && paths.length === 0) continue;
		const expanded = withFiles(command, paths);
		const shared = verifyCommands.includes(expanded);
		const result = await runCheck(
			expanded,
			cwd,
			shared ? verifyOptions : { timeoutMs: verifyOptions.timeoutMs },
		);
		if (shared) turnEndResults.set(expanded, result);
		if (!result.ok)
			(result.admission ? endDeferred : endProblems).push(
				`${command}\n${tidy(result.output, 4000)}`,
			);
	}
	pushScheduledCheck(checks, "Checks", endProblems, endDeferred);

	let layoutRules: LayoutRule[] = [];
	try {
		const rules = loadRuleSet(config);
		layoutRules = rules.layout;
		const findings = await findInFiles(rules.code, absolute, config.root);
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

	if (layoutRules.length > 0) {
		const findings = layoutFindings(
			layoutRules,
			changed.filter((path) => existsSync(join(cwd, path))),
		);
		const line = (finding: (typeof findings)[number]) =>
			`${finding.rule}: ${finding.message} (${finding.detail}.) Instead: ${finding.instead}`;
		checks.push(
			check(
				"Layout",
				findings.map((finding) => `${finding.path} ${line(finding)}`),
				findings.map((finding) => ({
					file: finding.path,
					message: line(finding),
				})),
			),
		);
	}

	const risk = classify(changed, config);
	checks.push({
		name: "Risk",
		ok: true,
		output: riskReport(risk),
		annotations: [],
	});

	if (pullRequest && config.review.pr_sections.length > 0) {
		const missing = missingSections(
			pullRequest.body ?? "",
			config.review.pr_sections,
		);
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
	if (verifyCommands.length > 0) {
		const problems: string[] = [];
		const deferred: string[] = [];
		for (const command of verifyCommands) {
			const result =
				turnEndResults.get(command) ??
				(await runCheck(command, cwd, verifyOptions));
			if (!result.ok)
				(result.admission ? deferred : problems).push(
					`${command}\n${tidy(result.output, 4000)}`,
				);
		}
		pushScheduledCheck(checks, "Verify", problems, deferred);
	}
	if (await out(["git", "status", "--porcelain", "-z"], cwd))
		checks.push(
			check("Clean checkout after checks", [
				"Checks changed the checkout. Commit fixes and rerun cagr ci from a clean checkout.",
			]),
		);
	for (const entry of checks)
		for (const note of entry.annotations) {
			if (note.file)
				note.file = relative(
					git.toplevel ?? config.root,
					resolve(config.root, note.file),
				).replaceAll("\\", "/");
		}
	return { ok: checks.every((entry) => entry.ok), checks, tier: risk.tier };
}

function pushScheduledCheck(
	checks: CiCheck[],
	name: string,
	problems: string[],
	deferred: string[],
) {
	if (problems.length || !deferred.length) checks.push(check(name, problems));
	if (deferred.length)
		checks.push({
			...check(problems.length ? `${name} (load)` : name, deferred),
			deferred: true,
		});
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
						`::${entry.deferred ? "warning" : "error"} title=${escapeProperty(entry.name)}::${escapeData(entry.output)}`,
					],
		);
}

export function ciReport(result: CiResult): string {
	return result.checks
		.map(
			(entry) =>
				`${entry.ok ? "PASS" : entry.deferred ? "DEFERRED" : "FAIL"} ${entry.name}${entry.output ? `\n${entry.output.replace(/^/gm, "  ")}` : ""}`,
		)
		.join("\n");
}

export function summary(result: CiResult) {
	const rows = result.checks.map(
		(entry) =>
			`| ${entry.ok ? "pass" : entry.deferred ? "**deferred**" : "**fail**"} | ${entry.name} |`,
	);
	const failed = result.checks.filter((entry) => !entry.ok);
	return [
		`## cagr: ${result.ok ? "all checks pass" : `${failed.length} check${failed.length === 1 ? "" : "s"} incomplete or failed`}`,
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
