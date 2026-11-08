import { readFileSync } from "node:fs";
import type { Config } from "../config/schema";
import { run } from "../run";
import type { ReviewAgent } from "./agent";
import { reviewReport } from "./report";
import { ReviewInputError, type ReviewOutcome, review } from "./review";
import {
	blocking,
	emptyRecord,
	type ReviewFinding,
	type ReviewRecord,
} from "./types";

/** Runs `gh` with args, optional stdin, and returns stdout. Injected in tests. */
export type Gh = (args: string[], stdin?: string) => Promise<string>;

export const ghCli: Gh = async (args, stdin) => {
	const result = await run(["gh", ...args], process.cwd(), {
		stdin,
		timeoutMs: 60_000,
	});
	if (!result.ok)
		throw new Error(
			`gh ${args.slice(0, 3).join(" ")} failed: ${result.output.trim().slice(0, 400)}`,
		);
	return result.stdout;
};

const marker = "cagr-review";
const stateLine = /<!-- cagr-review ([A-Za-z0-9+/=]+) -->/;

export const encodeState = (record: ReviewRecord) =>
	`<!-- ${marker} ${Buffer.from(JSON.stringify(record)).toString("base64")} -->`;

export function decodeState(body: string): ReviewRecord | null {
	const match = body.match(stateLine);
	if (!match?.[1]) return null;
	try {
		const record = JSON.parse(
			Buffer.from(match[1], "base64").toString("utf8"),
		) as ReviewRecord;
		return record.version === 1 ? record : null;
	} catch {
		return null;
	}
}

export type PullRequest = {
	number: number;
	repo: string;
	base: string;
	head: string;
	body: string;
};

export function pullRequestFromEvent(
	env: Record<string, string | undefined> = process.env,
): PullRequest {
	const path = env.GITHUB_EVENT_PATH;
	if (!path || !env.GITHUB_REPOSITORY)
		throw new ReviewInputError(
			"`cagr review --ci` runs in GitHub Actions on a pull_request event.",
		);
	const event = JSON.parse(readFileSync(path, "utf8")) as {
		pull_request?: {
			number: number;
			body: string | null;
			base: { ref: string };
			head: { sha: string };
		};
	};
	if (!event.pull_request)
		throw new ReviewInputError(
			"This event has no pull request. Run `cagr review --ci` on pull_request events.",
		);
	return {
		number: event.pull_request.number,
		repo: env.GITHUB_REPOSITORY,
		base: event.pull_request.base.ref,
		head: event.pull_request.head.sha,
		body: event.pull_request.body ?? "",
	};
}

type Comment = { id: number; body: string; login: string };

/** The workflow posts as github-actions. REST names it "github-actions[bot]", GraphQL "github-actions". */
export const isWorkflowBot = (login: string | null | undefined) =>
	login?.replace(/\[bot\]$/, "") === "github-actions";

// Only the workflow's own comment counts: anyone can post a comment that carries the marker.
async function stateComment(gh: Gh, pr: PullRequest): Promise<Comment | null> {
	const out = await gh([
		"api",
		"--paginate",
		`repos/${pr.repo}/issues/${pr.number}/comments`,
		"--jq",
		".[] | {id, body, login: .user.login}",
	]);
	const comments = out
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Comment);
	return (
		comments.findLast(
			(comment) => isWorkflowBot(comment.login) && stateLine.test(comment.body),
		) ?? null
	);
}

const resolvedQuery = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviewThreads(first: 100) { nodes { isResolved resolvedBy { login } comments(first: 1) { nodes { body author { login } } } } }
  } }
}`;

/** Findings whose inline thread a person resolved on GitHub. Resolving counts as an answer. */
export async function resolvedFindings(
	gh: Gh,
	pr: PullRequest,
): Promise<Map<string, string>> {
	const [owner, name] = pr.repo.split("/");
	const out = await gh([
		"api",
		"graphql",
		"-f",
		`query=${resolvedQuery}`,
		"-f",
		`owner=${owner}`,
		"-f",
		`name=${name}`,
		"-F",
		`number=${pr.number}`,
	]);
	const data = JSON.parse(out) as {
		data?: {
			repository?: {
				pullRequest?: {
					reviewThreads?: {
						nodes: {
							isResolved: boolean;
							resolvedBy: { login: string } | null;
							comments: {
								nodes: { body: string; author: { login: string } | null }[];
							};
						}[];
					};
				};
			};
		};
	};
	const resolved = new Map<string, string>();
	for (const thread of data.data?.repository?.pullRequest?.reviewThreads
		?.nodes ?? []) {
		const first = thread.comments.nodes[0];
		// A thread counts only when the workflow started it, so a hand-made comment with the marker does not.
		if (!thread.isResolved || !isWorkflowBot(first?.author?.login)) continue;
		const id = first?.body.match(/<!-- cagr:(f\d+) -->/)?.[1];
		if (id) resolved.set(id, thread.resolvedBy?.login ?? "someone");
	}
	return resolved;
}

const commentBody = (finding: ReviewFinding) =>
	`**${finding.severity === "important" ? "Important" : finding.severity === "nit" ? "Nit" : "Pre-existing"}** (${finding.category}, ${finding.id}): ${finding.title}\n\n${finding.detail}${finding.bug_class ? `\n\nClass: ${finding.bug_class}.` : ""}\n\nFix it, or resolve this thread with a reply saying why it is wrong, intentional or minor.\n<!-- cagr:${finding.id} -->`;

/** Posts the round as a PR review with inline comments. Comments GitHub cannot place go in the body. */
export async function postReview(
	gh: Gh,
	pr: PullRequest,
	outcome: ReviewOutcome,
	maxRounds: number,
) {
	const inline = outcome.found.filter(
		(finding) => finding.file && finding.line > 0,
	);
	const loose = outcome.found.filter((finding) => !inline.includes(finding));
	const body = [
		`### cagr review\n\n${reviewReport(outcome, maxRounds)}`,
		...loose.map(commentBody),
	].join("\n\n---\n\n");
	const payload = (comments: ReviewFinding[]) =>
		JSON.stringify({
			commit_id: pr.head,
			event: "COMMENT",
			body,
			comments: comments.map((finding) => ({
				path: finding.file,
				line: finding.line,
				side: "RIGHT",
				body: commentBody(finding),
			})),
		});
	const endpoint = `repos/${pr.repo}/pulls/${pr.number}/reviews`;
	try {
		await gh(["api", "-X", "POST", endpoint, "--input", "-"], payload(inline));
	} catch {
		// A line outside the diff makes GitHub reject the whole review, so fall back to the body alone.
		const all = [body, ...inline.map(commentBody)].join("\n\n---\n\n");
		await gh(
			["api", "-X", "POST", endpoint, "--input", "-"],
			JSON.stringify({
				commit_id: pr.head,
				event: "COMMENT",
				body: all,
			}),
		);
	}
}

async function saveState(
	gh: Gh,
	pr: PullRequest,
	existing: Comment | null,
	record: ReviewRecord,
) {
	const open = blocking(record);
	const body = `**cagr review**: ${open.length === 0 ? "no Important finding open." : `${open.length} Important finding${open.length === 1 ? "" : "s"} open (${open.map((finding) => finding.id).join(", ")}).`}\n\n${encodeState(record)}`;
	const path = existing
		? `repos/${pr.repo}/issues/comments/${existing.id}`
		: `repos/${pr.repo}/issues/${pr.number}/comments`;
	await gh(
		["api", "-X", existing ? "PATCH" : "POST", path, "--input", "-"],
		JSON.stringify({ body }),
	);
}

/** One CI review round on a pull request. Fails while an Important finding is open. */
export async function ciReview(
	config: Config,
	cwd: string,
	options: {
		gh?: Gh;
		agent?: ReviewAgent;
		env?: Record<string, string | undefined>;
		progress?: (line: string) => void;
	} = {},
): Promise<{ ok: boolean; report: string }> {
	const gh = options.gh ?? ghCli;
	const pr = pullRequestFromEvent(options.env);
	const existing = await stateComment(gh, pr);
	const record =
		(existing && decodeState(existing.body)) ??
		emptyRecord(`pr-${pr.number}`, pr.base);
	for (const [id, who] of await resolvedFindings(gh, pr).catch(
		() => new Map<string, string>(),
	)) {
		const finding = record.findings.find((entry) => entry.id === id);
		if (finding?.status === "open") {
			finding.status = "answered";
			finding.answer = {
				kind: "intentional",
				reason: `Thread resolved on GitHub by ${who}.`,
			};
		}
	}
	const checkedOut = (
		await run(["git", "rev-parse", "HEAD"], cwd)
	).stdout.trim();
	if (checkedOut !== pr.head)
		throw new ReviewInputError(
			`The checkout is ${checkedOut.slice(0, 7)}, not the pull request's head ${pr.head.slice(0, 7)}, so the review would cover the wrong commit. Check out the head: in actions/checkout, set \`ref: \${{ github.event.pull_request.head.sha }}\`, or run \`cagr sync\` to rewrite the workflow.`,
		);
	const outcome = await review(config, {
		cwd,
		base: pr.base,
		record,
		agent: options.agent,
		progress: options.progress,
	});
	let posted = "";
	if (!outcome.skipped)
		await postReview(gh, pr, outcome, config.review.max_rounds).catch(
			(error: Error) => {
				posted = `\n\nThe review could not be posted to the pull request: ${error.message}`;
			},
		);
	await saveState(gh, pr, existing, outcome.record);
	const report = `${reviewReport(outcome, config.review.max_rounds)}${posted}`;
	// Fail open: a reviewer that could not run does not hold the pull request, but findings already open still do.
	return {
		ok: outcome.round?.error
			? blocking(outcome.record).length === 0
			: outcome.passed,
		report,
	};
}
