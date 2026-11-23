import type { Config } from "../config/schema";
import { gitContext } from "../git";
import { cappedReview, gateAtHead } from "./gate";
import type { Gh } from "./github";
import { readBranchRecord, recordPath } from "./store";
import { completedRounds, type ReviewRecord } from "./types";

export const reviewContext = "cagr/review";
export const checksContext = "cagr/checks";
export const leasesContext = "cagr/leases";

export async function latestStatuses(gh: Gh, repo: string, sha: string) {
	const statuses = (
		await gh([
			"api",
			"--paginate",
			`repos/${repo}/commits/${sha}/statuses?per_page=100`,
			"--jq",
			".[] | [(.context | ascii_downcase), .state] | @tsv",
		])
	).split(/\r?\n/);
	const latest = new Map<string, string>();
	for (const row of statuses) {
		const [context, state] = row.split("\t");
		if (context && state && !latest.has(context)) latest.set(context, state);
	}
	return latest;
}

export async function successfulStatuses(gh: Gh, repo: string, sha: string) {
	return new Set(
		[...(await latestStatuses(gh, repo, sha))]
			.filter(([, state]) => state === "success")
			.map(([context]) => context),
	);
}

export type CommitStatus = {
	context: string;
	state: "success" | "failure" | "pending";
	description: string;
};

/** GitHub cuts status descriptions at 140 characters. */
const describe = (text: string) =>
	text.length <= 140 ? text : `${text.slice(0, 139)}…`;

/**
 * The `cagr/review` status for a commit: the review gate's answer, in GitHub's
 * terms. Both the pre-push hook and `cagr review answer` send this.
 */
export async function reviewStatus(
	record: ReviewRecord | null,
	sha: string,
	config: Config,
	cwd: string,
): Promise<CommitStatus> {
	const gate = await gateAtHead(record, sha, config, cwd);
	const status = (state: CommitStatus["state"], text: string) => ({
		context: reviewContext,
		state,
		description: describe(text),
	});
	const cap =
		record && completedRounds(record) >= config.review.max_rounds
			? cappedReview(config.review.max_rounds)
			: "";
	if (gate.kind === "allow")
		return gate.coverage
			? status("success", gate.coverage)
			: gate.notice
				? status(
						"success",
						"Unreviewed: the reviewer failed and no Important finding is open. Review this commit yourself.",
					)
				: status(
						"success",
						cap
							? `${cap} No Important finding is open.`
							: "Passed: no Important finding is open.",
					);
	const open = gate.openCount;
	if (open) {
		const findings = `${open} Important finding${open === 1 ? "" : "s"} open.`;
		return status(
			"failure",
			gate.coverage
				? `${gate.coverage} ${findings}`
				: cap
					? `${cap} ${findings}`
					: `${findings} Fix or answer ${open === 1 ? "it" : "them"}, then run cagr review.`,
		);
	}
	return status("pending", "Not reviewed at this commit. Run cagr review.");
}

/** Why a status did not reach GitHub, and what to do. */
function failureNote(message: string, sha: string, context: string) {
	const short = sha.slice(0, 7);
	const off = "or set [review] status = false";
	if (/Could not start `gh/.test(message))
		return `gh is not installed, so GitHub did not get ${context} for ${short}. Install gh and run \`gh auth login\`, ${off}.`;
	if (/auth login|not logged in|HTTP 401|Bad credentials/i.test(message))
		return `gh is not logged in, so GitHub did not get ${context} for ${short}. Run \`gh auth login\`, ${off}.`;
	if (/HTTP 422|No commit found/i.test(message))
		return `GitHub does not have ${short} yet, so it did not get ${context}. Push the branch: the pre-push hook sends the status once the push lands.`;
	return `GitHub did not get ${context} for ${short}: ${message.trim().slice(0, 300)}. Check that gh can write commit statuses here (\`gh auth status\`), ${off}.`;
}

/** Sets a commit status through `gh api`. Never throws: returns what happened, for a person to read. */
export async function postStatus(
	gh: Gh,
	sha: string,
	status: CommitStatus,
	repo?: string,
): Promise<{ ok: boolean; message: string }> {
	try {
		await gh([
			"api",
			"-X",
			"POST",
			`repos/${repo ?? "{owner}/{repo}"}/statuses/${sha}`,
			"-f",
			`state=${status.state}`,
			"-f",
			`context=${status.context}`,
			"-f",
			`description=${status.description}`,
		]);
		return {
			ok: true,
			message: `Set ${status.context} to ${status.state} on ${sha.slice(0, 7)}.`,
		};
	} catch (error) {
		return {
			ok: false,
			message: repo
				? `GitHub did not get ${status.context} for ${sha.slice(0, 7)}. Check that gh can write commit statuses (\`gh auth status\`). ${(error as Error).message}`
				: failureNote((error as Error).message, sha, status.context),
		};
	}
}

/** Sends `cagr/review` for HEAD of the current branch, from its review record. */
export async function sendReviewStatus(
	config: Config,
	cwd: string,
	gh: Gh,
): Promise<string | null> {
	if (!config.review.status) return null;
	const git = await gitContext(cwd);
	if (!git.commonDir || !git.branch || !git.head) return null;
	const record = readBranchRecord(
		recordPath(git.commonDir, git.branch),
		git.branch,
	);
	return (
		await postStatus(
			gh,
			git.head,
			await reviewStatus(record, git.head, config, cwd),
		)
	).message;
}

export type PostStatusOptions = {
	sha: string;
	branch: string;
	checks: string[] | null;
	waitSeconds: number;
};

/**
 * Run by the pre-push hook in the background: waits until GitHub has the
 * pushed commit, then sets `cagr/checks` (when the hook's commands ran on that
 * commit) and `cagr/review`. Returns lines for the log.
 */
export async function postStatusAfterPush(
	config: Config,
	cwd: string,
	options: PostStatusOptions,
	gh: Gh,
	sleep = (ms: number) => Bun.sleep(ms),
): Promise<string[]> {
	const deadline = Date.now() + options.waitSeconds * 1000;
	for (;;) {
		try {
			await gh([
				"api",
				`repos/{owner}/{repo}/commits/${options.sha}`,
				"--silent",
			]);
			break;
		} catch (error) {
			// gh missing or logged out will not fix itself: go on and let the post explain.
			if (
				!/HTTP 422|HTTP 404|No commit found/i.test((error as Error).message) ||
				Date.now() >= deadline
			)
				break;
			await sleep(3000);
		}
	}
	const lines: string[] = [];
	if (options.checks)
		lines.push(
			(
				await postStatus(gh, options.sha, {
					context: checksContext,
					state: "success",
					description: describe(
						`The pre-push commands passed: ${options.checks.join(", ")}`,
					),
				})
			).message,
		);
	const git = await gitContext(cwd);
	const record = git.commonDir
		? readBranchRecord(
				recordPath(git.commonDir, options.branch),
				options.branch,
			)
		: null;
	lines.push(
		(
			await postStatus(
				gh,
				options.sha,
				await reviewStatus(record, options.sha, config, cwd),
			)
		).message,
	);
	return lines;
}
