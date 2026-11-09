import { type Config, type Effort, efforts } from "../config/schema";
import { gitContext } from "../git";
import { classify, riskReport } from "../risk";
import { run } from "../run";
import { evalReport, readLastRun, runEvals, writeLastRun } from "./eval";
import { ciReview, type Gh, ghCli } from "./github";
import {
	answerFinding,
	reviewReport,
	reviewStats,
	statsReport,
	statusReport,
} from "./report";
import { ReviewInputError, resolveBase, review } from "./review";
import { sendReviewStatus } from "./status";
import { allRecords, readRecord, recordPath, writeRecord } from "./store";
import { type AnswerKind, answerKinds } from "./types";

export const reviewHelp = `Usage: cagr review [options]

  review [--base <branch>] [--full] [--effort quick|standard|deep]
                               Review this branch's commits with a reviewer agent. After round 1 only new commits.
  review --scan <globs...> [--issue]
                               Review existing code. --issue opens a GitHub issue with the findings.
  review --ci                  In GitHub Actions: review the pull request and post the findings on it.
  review answer <id> --wrong|--intentional|--minor "<why>"
                               Answer a finding instead of fixing it. A person reads every answer.
  review status                The findings on this branch and their state.
  review stats                 Rounds to pass and how findings were answered, across branches.
  review eval [--case <name>]  Score the reviewer on .cagr/review-evals/*.toml.

Exit codes: 0 passed, 1 Important findings open, 2 error.`;

function take(args: string[], name: string) {
	const index = args.indexOf(name);
	if (index === -1) return undefined;
	const value = args[index + 1];
	args.splice(index, 2);
	if (value === undefined || value.startsWith("--"))
		throw new ReviewInputError(`${name} needs a value.\n\n${reviewHelp}`);
	return value;
}

function takeFlag(args: string[], name: string) {
	const index = args.indexOf(name);
	if (index === -1) return false;
	args.splice(index, 1);
	return true;
}

/** The options of a plain `cagr review`. Throws on anything else. */
export function parseReviewArgs(args: string[]) {
	const rest = [...args];
	const issue = takeFlag(rest, "--issue");
	const base = take(rest, "--base");
	const effort = takeEffort(rest);
	const full = takeFlag(rest, "--full");
	let scan: string[] | undefined;
	const scanIndex = rest.indexOf("--scan");
	if (scanIndex !== -1) {
		// The globs run up to the next option, so options may come before or after them.
		let end = scanIndex + 1;
		while (end < rest.length && !rest[end]?.startsWith("-")) end++;
		scan = rest.splice(scanIndex, end - scanIndex).slice(1);
		if (scan.length === 0)
			throw new ReviewInputError(
				"Name the globs to scan: cagr review --scan 'src/**'",
			);
	}
	if (rest.length > 0)
		throw new ReviewInputError(`Unknown option ${rest[0]}.\n\n${reviewHelp}`);
	return { scan, issue, base, effort, full };
}

function takeEffort(args: string[]): Effort | undefined {
	const value = take(args, "--effort");
	if (value !== undefined && !efforts.includes(value as Effort))
		throw new ReviewInputError(`--effort is one of ${efforts.join(", ")}.`);
	return value as Effort | undefined;
}

const progress = (line: string) => console.error(line);

async function branchRecord(cwd: string) {
	const git = await gitContext(cwd);
	if (!git.commonDir || !git.branch)
		throw new ReviewInputError("Run this on a branch inside a git repo.");
	const file = recordPath(git.commonDir, git.branch);
	return { git, file, record: readRecord(file) };
}

/** Tells GitHub the review's state when [review] status is on. Never fails the command. */
async function reportStatus(config: Config, cwd: string, gh: Gh) {
	const note = await sendReviewStatus(config, cwd, gh);
	if (note) console.error(`cagr: ${note}`);
}

export async function reviewCommand(
	config: Config,
	args: string[],
	cwd: string,
	gh: Gh = ghCli,
): Promise<number> {
	const sub = args[0];
	if (sub === "help" || args.includes("--help")) {
		console.log(reviewHelp);
		return 0;
	}
	if (sub === "answer") {
		const id = args[1];
		const kind = answerKinds.find((entry) => args.includes(`--${entry}`)) as
			| AnswerKind
			| undefined;
		if (!id || !kind)
			throw new ReviewInputError(
				`Usage: cagr review answer <id> --wrong|--intentional|--minor "<why>"`,
			);
		const reason = args[args.indexOf(`--${kind}`) + 1] ?? "";
		const { file, record } = await branchRecord(cwd);
		const finding = answerFinding(record, id, kind, reason);
		if (record) writeRecord(file, record);
		console.log(
			`Answered ${finding.id} as ${kind}. ${record?.findings.some((entry) => entry.status === "open" && entry.severity === "important") ? "Other Important findings are still open." : "No Important finding is open."}`,
		);
		await reportStatus(config, cwd, gh);
		return 0;
	}
	if (sub === "status") {
		const { git, record } = await branchRecord(cwd);
		console.log(statusReport(record, git.head));
		return 0;
	}
	if (sub === "stats") {
		const git = await gitContext(cwd);
		if (!git.commonDir)
			throw new ReviewInputError("Run this inside a git repo.");
		console.log(statsReport(reviewStats(allRecords(git.commonDir))));
		return 0;
	}
	if (sub === "eval") {
		const rest = args.slice(1);
		const only = take(rest, "--case");
		const effort = takeEffort(rest);
		const git = await gitContext(cwd);
		if (!git.commonDir)
			throw new ReviewInputError("Run this inside a git repo.");
		const results = await runEvals(config, cwd, { only, effort, progress });
		console.log(evalReport(results, readLastRun(git.commonDir)));
		if (!only) writeLastRun(git.commonDir, results);
		return results.some((entry) => entry.error) ? 2 : 0;
	}
	const rest = [...args];
	if (takeFlag(rest, "--ci")) {
		const result = await ciReview(config, cwd, { progress });
		console.log(result.report);
		return result.ok ? 0 : 1;
	}
	const { scan, issue, base, effort, full } = parseReviewArgs(rest);
	const outcome = await review(config, {
		cwd,
		base,
		full,
		effort,
		scan,
		progress,
	});
	const report = reviewReport(outcome, config.review.max_rounds);
	console.log(report);
	if (!scan) await reportStatus(config, cwd, gh);
	if (scan && issue && outcome.found.length > 0) {
		const url = await ghCli(
			[
				"issue",
				"create",
				"--title",
				`cagr scan: ${outcome.found.length} finding${outcome.found.length === 1 ? "" : "s"} in ${scan.join(", ")}`,
				"--body-file",
				"-",
			],
			report,
		);
		console.log(`Opened ${url.trim()}`);
	}
	if (outcome.round?.error) return 2;
	return outcome.passed &&
		(!scan || outcome.found.every((entry) => entry.severity !== "important"))
		? 0
		: 1;
}

export async function riskCommand(
	config: Config,
	args: string[],
	cwd: string,
): Promise<number> {
	const rest = [...args];
	const base = take(rest, "--base") ?? config.git.protected_branch ?? "main";
	const git = await gitContext(cwd);
	const root = git.toplevel ?? cwd;
	let paths = rest;
	if (paths.length === 0) {
		const ref = await resolveBase(base, root);
		const diff = await run(
			["git", "diff", "--name-only", `${ref}...HEAD`],
			root,
		);
		paths = diff.output.split("\n").filter(Boolean);
	}
	console.log(riskReport(classify(paths, config)));
	return 0;
}
