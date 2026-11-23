import { readFileSync } from "node:fs";
import type { Config } from "../config/schema";
import { gitContext } from "../git";
import { run } from "../run";
import type { ReviewAgent } from "./agent";
import { reachFrom, unresolved, unreviewedNotice } from "./gate";
import { reviewReport } from "./report";
import { ReviewInputError, type ReviewOutcome, review } from "./review";
import { reviewContext, successfulStatuses } from "./status";
import { readBranchRecord, recordPath } from "./store";
import {
	blocking,
	completedRounds,
	emptyRecord,
	type ReviewFinding,
	type ReviewRecord,
} from "./types";

/** Runs `gh` with args, optional stdin, and returns stdout. Injected in tests. */
export type Gh = (args: string[], stdin?: string) => Promise<string>;

export const ghAt =
	(cwd: string, runner = run): Gh =>
	async (args, stdin) => {
		const result = await runner(["gh", ...args], cwd, {
			stdin,
			timeoutMs: 60_000,
		});
		if (!result.ok)
			throw new Error(
				`gh ${args.slice(0, 3).join(" ")} failed: ${result.output.trim().slice(0, 400)}`,
			);
		return result.stdout;
	};
export const ghCli: Gh = (args, stdin) => ghAt(process.cwd())(args, stdin);

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
	headBranch: string;
	headRepo: string;
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
			head: { sha: string; ref: string; repo: { full_name: string } | null };
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
		headBranch: event.pull_request.head.ref,
		headRepo: event.pull_request.head.repo?.full_name ?? "",
		body: event.pull_request.body ?? "",
	};
}

type Comment = { id: number; body: string; login: string };

/** The workflow posts as github-actions. REST names it "github-actions[bot]", GraphQL "github-actions". */
export const isWorkflowBot = (login: string | null | undefined) =>
	login?.replace(/\[bot\]$/, "") === "github-actions";

function sameAuthor(left: string | null | undefined, right: string) {
	if (isWorkflowBot(right)) return isWorkflowBot(left);
	return left?.toLowerCase() === right.toLowerCase();
}

async function stateComments(
	gh: Gh,
	pr: Pick<PullRequest, "repo" | "number">,
	login?: string,
) {
	const out = await gh([
		"api",
		"--paginate",
		`repos/${pr.repo}/issues/${pr.number}/comments`,
		"--jq",
		".[] | {id, body, login: .user.login}",
	]);
	const states = new Map<string, { comment: Comment; record: ReviewRecord }>();
	for (const line of out.split("\n").filter(Boolean)) {
		const comment = JSON.parse(line) as Comment;
		const record = decodeState(comment.body);
		if (record && comment.login)
			states.set(comment.login.toLowerCase(), { comment, record });
	}
	return (
		await Promise.all(
			[...states.values()].map(async (state) => {
				const author = state.comment.login;
				if (isWorkflowBot(author) || (login && sameAuthor(author, login)))
					return state;
				const permission = (
					await gh([
						"api",
						`repos/${pr.repo}/collaborators/${encodeURIComponent(author)}/permission`,
						"--jq",
						".permission",
					]).catch((error: Error) => {
						if (/HTTP 404/.test(error.message)) return "";
						throw error;
					})
				).trim();
				return ["admin", "maintain", "write"].includes(permission)
					? state
					: null;
			}),
		)
	).filter((state) => state !== null);
}

export async function hasOpenCiFinding(gh: Gh, repo: string, number: number) {
	const states = await stateComments(gh, { repo, number });
	return states.some(({ record }) => blocking(record).length > 0);
}

async function earlierPrRecords(gh: Gh, pr: PullRequest, login?: string) {
	if (!pr.headRepo || !pr.headBranch) return [];
	const owner = pr.headRepo.split("/")[0];
	const out = await gh([
		"api",
		"--method",
		"GET",
		"--paginate",
		`repos/${pr.repo}/pulls?per_page=100`,
		"-f",
		"state=all",
		"-f",
		`head=${owner}:${pr.headBranch}`,
		"--jq",
		".[] | .number",
	]);
	const earlier = out
		.split("\n")
		.map(Number)
		.filter((number) => number > 0 && number !== pr.number);
	// Read one PR at a time to avoid a burst of requests on long-lived branches.
	const records: ReviewRecord[] = [];
	for (const number of earlier)
		records.push(
			...(await stateComments(gh, { repo: pr.repo, number }, login)).map(
				({ record }) => record,
			),
		);
	return records;
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
	isReviewer = isWorkflowBot,
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
		if (!thread.isResolved || !isReviewer(first?.author?.login)) continue;
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
	open: ReviewFinding[],
) {
	const body = `**cagr review**: ${open.length === 0 ? "no Important finding open." : `${open.length} Important finding${open.length === 1 ? "" : "s"} open (${open.map((finding) => finding.id).join(", ")}).`}\n\n${encodeState(record)}`;
	const path = existing
		? `repos/${pr.repo}/issues/comments/${existing.id}`
		: `repos/${pr.repo}/issues/${pr.number}/comments`;
	await gh(
		["api", "-X", existing ? "PATCH" : "POST", path, "--input", "-"],
		JSON.stringify({ body }),
	);
}

const readOnlyToken = /\b403\b|Resource not accessible by integration/i;

async function applyThreadAnswers(
	gh: Gh,
	pr: PullRequest,
	record: ReviewRecord,
	author: string,
) {
	for (const [id, who] of await resolvedFindings(gh, pr, (login) =>
		sameAuthor(login, author),
	).catch(() => new Map<string, string>())) {
		const finding = record.findings.find((entry) => entry.id === id);
		if (finding?.status === "open") {
			finding.status = "answered";
			finding.answer = {
				kind: "intentional",
				reason: `Thread resolved on GitHub by ${who}.`,
			};
		}
	}
}

/** Judge existing findings, and run a CI round only while the branch has budget. */
export async function ciReview(
	config: Config,
	cwd: string,
	options: {
		gh?: Gh;
		agent?: ReviewAgent;
		env?: Record<string, string | undefined>;
		progress?: (line: string) => void;
		local?: {
			pr: PullRequest;
			login: string;
			sourceRoot?: string;
			statusPassed?: boolean;
		};
	} = {},
) {
	const gh = options.gh ?? ghCli;
	const pr = options.local?.pr ?? pullRequestFromEvent(options.env);
	const login = options.local?.login ?? "github-actions[bot]";
	const checkedOut = (
		await run(["git", "rev-parse", "HEAD"], cwd)
	).stdout.trim();
	if (checkedOut !== pr.head)
		throw new ReviewInputError(
			`The checkout is ${checkedOut.slice(0, 7)}, not the pull request's head ${pr.head.slice(0, 7)}, so the review would cover the wrong commit. Check out the head: in actions/checkout, set \`ref: \${{ github.event.pull_request.head.sha }}\`, or run \`cagr sync\` to rewrite the workflow.`,
		);
	const [states, statusPassed] = await Promise.all([
		stateComments(gh, pr, login),
		options.local
			? options.local.statusPassed === true
			: successfulStatuses(gh, pr.repo, pr.head)
					.then((passed) => passed.has(reviewContext))
					.catch(() => false),
	]);
	if (
		statusPassed &&
		states.every(({ record }) => blocking(record).length === 0)
	)
		return {
			ok: true,
			complete: true,
			report:
				"Skipping review: cagr/review passed and no CI Important finding is open.",
			coverage: undefined,
		};

	const own = states.find(({ comment }) => sameAuthor(comment.login, login));
	const existing = own?.comment ?? null;
	const record = own?.record ?? emptyRecord(`pr-${pr.number}`, pr.base);
	const others = states.filter((state) => state !== own);
	for (const state of states)
		if (blocking(state.record).length > 0)
			await applyThreadAnswers(gh, pr, state.record, state.comment.login);

	const otherOpen = (
		await Promise.all(
			others.map(async ({ record }) =>
				unresolved(record, pr.head, await reachFrom(record, pr.head, cwd)),
			),
		)
	).flat();
	if (statusPassed) {
		const open = [
			...unresolved(record, pr.head, await reachFrom(record, pr.head, cwd)),
			...otherOpen,
		];
		if (existing) await saveState(gh, pr, existing, record, open);
		const detail = open.map(({ id, title }) => `${id} ${title}`).join(", ");
		return {
			ok: open.length === 0,
			complete: true,
			coverage: undefined,
			report: `CI judged the gate from existing findings. ${detail ? `Open Important findings: ${detail}` : "No Important finding is open."}`,
		};
	}

	const { commonDir } = await gitContext(options.local?.sourceRoot ?? cwd);
	const localRecord =
		commonDir &&
		pr.headBranch &&
		pr.headRepo.toLowerCase() === pr.repo.toLowerCase()
			? readBranchRecord(recordPath(commonDir, pr.headBranch), pr.headBranch)
			: null;
	const earlier = await earlierPrRecords(gh, pr, login);
	const priorRounds = [
		...earlier,
		...others.map(({ record }) => record),
		...(localRecord ? [localRecord] : []),
	].reduce((total, history) => total + completedRounds(history), 0);
	const outcome = await review(config, {
		cwd,
		base: pr.base,
		record,
		priorRounds,
		agent: options.agent,
		progress: options.progress,
	});
	const localOpen =
		outcome.capped && localRecord
			? unresolved(
					localRecord,
					pr.head,
					await reachFrom(localRecord, pr.head, cwd),
				)
			: [];
	const priorReview = localRecord ?? others[0]?.record ?? earlier[0];
	const coverage =
		outcome.coverage ??
		(outcome.capped && priorReview
			? await unreviewedNotice(
					priorReview,
					pr.head,
					cwd,
					config.review.max_rounds,
				)
			: undefined);
	const externalOpen = [...otherOpen, ...localOpen];
	let posted = "";
	if (!outcome.skipped)
		await postReview(gh, pr, outcome, config.review.max_rounds).catch(
			(error: Error) => {
				posted = `\n\nThe review could not be posted to the pull request: ${error.message}`;
			},
		);
	let saved = "";
	await saveState(gh, pr, existing, outcome.record, outcome.open).catch(
		(error: Error) => {
			saved = `\n\nThe review state could not be saved to the pull request, so the next run starts over: ${error.message}`;
			if (readOnlyToken.test(error.message))
				saved += options.local
					? "\nRun `gh auth login` with an account that can post to this pull request."
					: "\nThe token cannot write to this pull request. GitHub gives pull requests from forks a read-only token and no secrets, so this job cannot review them. Review fork pull requests by hand, or run `cagr review` on a branch in this repo.";
		},
	);
	const external = externalOpen.length
		? `\n\nImportant findings open in other branch review records: ${externalOpen.map(({ id, title }) => `${id} ${title}`).join(", ")}`
		: "";
	const coverageNote = coverage && !outcome.coverage ? `\n\n${coverage}` : "";
	const report = `${reviewReport(outcome, config.review.max_rounds)}${coverageNote}${external}${posted}${saved}`;
	// Fail open: a reviewer that could not run does not hold the pull request, but findings not closed at this head still do.
	return {
		complete: !outcome.round?.error && posted === "" && saved === "",
		ok:
			externalOpen.length === 0 &&
			(outcome.round?.error ? outcome.open.length === 0 : outcome.passed),
		coverage,
		report,
	};
}
