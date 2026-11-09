import type { Config } from "../config/schema";
import { gitContext } from "../git";
import { gateResult } from "./gate";
import type { Gh } from "./github";
import { readRecord, recordPath } from "./store";
import { blocking, type ReviewRecord } from "./types";

export const reviewContext = "cagr/review";
export const checksContext = "cagr/checks";

export type CommitStatus = {
	context: string;
	state: "success" | "failure" | "pending";
	description: string;
};

/** GitHub cuts status descriptions at 140 characters. */
const describe = (text: string) =>
	text.length <= 140 ? text : `${text.slice(0, 139)}…`;

/** The `cagr/review` status for a commit: the review gate's answer, in GitHub's terms. */
export function reviewStatus(
	record: ReviewRecord | null,
	sha: string,
	config: Config,
): CommitStatus {
	const gate = gateResult(record, sha, config);
	const status = (state: CommitStatus["state"], text: string) => ({
		context: reviewContext,
		state,
		description: describe(text),
	});
	if (gate.kind === "allow")
		return gate.notice
			? status(
					"success",
					"The review could not run, so this went out unreviewed. Review it yourself.",
				)
			: status("success", "Passed: no Important finding is open.");
	const open = record ? blocking(record).length : 0;
	if (record?.rounds.at(-1)?.head === sha && open > 0)
		return status(
			"failure",
			`${open} Important finding${open === 1 ? "" : "s"} open. Fix or answer ${open === 1 ? "it" : "them"}, then run cagr review.`,
		);
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
): Promise<{ ok: boolean; message: string }> {
	try {
		await gh([
			"api",
			"-X",
			"POST",
			`repos/{owner}/{repo}/statuses/${sha}`,
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
			message: failureNote((error as Error).message, sha, status.context),
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
	const record = readRecord(recordPath(git.commonDir, git.branch));
	return (
		await postStatus(gh, git.head, reviewStatus(record, git.head, config))
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
		? readRecord(recordPath(git.commonDir, options.branch))
		: null;
	lines.push(
		(
			await postStatus(
				gh,
				options.sha,
				reviewStatus(record, options.sha, config),
			)
		).message,
	);
	return lines;
}
