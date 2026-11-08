import type { Config } from "./config/schema";
import type { Gh } from "./review/github";

export type Line = { ok: boolean; text: string };

type Protection = {
	approvals: number;
	dismissStale: boolean;
	codeOwners: boolean;
	threads: boolean;
	checks: string[];
	mergeQueue: boolean;
	found: boolean;
};

const none: Protection = {
	approvals: 0,
	dismissStale: false,
	codeOwners: false,
	threads: false,
	checks: [],
	mergeQueue: false,
	found: false,
};

async function json<T>(gh: Gh, args: string[]): Promise<T | null> {
	try {
		return JSON.parse(await gh(args)) as T;
	} catch {
		return null;
	}
}

type Classic = {
	required_pull_request_reviews?: {
		required_approving_review_count?: number;
		dismiss_stale_reviews?: boolean;
		require_code_owner_reviews?: boolean;
	};
	required_status_checks?: {
		contexts?: string[];
		checks?: { context: string }[];
	};
	required_conversation_resolution?: { enabled?: boolean };
};
type Rule = { type: string; parameters?: Record<string, unknown> };

/** Branch protection and rulesets together: GitHub enforces both. */
export async function readProtection(
	gh: Gh,
	repo: string,
	branch: string,
): Promise<Protection> {
	const result = { ...none, checks: [] as string[] };
	const classic = await json<Classic>(gh, [
		"api",
		`repos/${repo}/branches/${branch}/protection`,
	]);
	if (classic) {
		result.found = true;
		const reviews = classic.required_pull_request_reviews;
		result.approvals = reviews?.required_approving_review_count ?? 0;
		result.dismissStale = reviews?.dismiss_stale_reviews ?? false;
		result.codeOwners = reviews?.require_code_owner_reviews ?? false;
		result.threads = classic.required_conversation_resolution?.enabled ?? false;
		result.checks.push(
			...(classic.required_status_checks?.contexts ?? []),
			...(classic.required_status_checks?.checks ?? []).map(
				(check) => check.context,
			),
		);
	}
	const rules = await json<Rule[]>(gh, [
		"api",
		`repos/${repo}/rules/branches/${branch}`,
	]);
	for (const rule of rules ?? []) {
		result.found = true;
		const p = rule.parameters ?? {};
		if (rule.type === "pull_request") {
			result.approvals = Math.max(
				result.approvals,
				Number(p.required_approving_review_count ?? 0),
			);
			result.dismissStale ||= p.dismiss_stale_reviews_on_push === true;
			result.codeOwners ||= p.require_code_owner_review === true;
			result.threads ||= p.required_review_thread_resolution === true;
		}
		if (rule.type === "required_status_checks")
			result.checks.push(
				...(
					(p.required_status_checks as { context: string }[] | undefined) ?? []
				).map((check) => check.context),
			);
		if (rule.type === "merge_queue") result.mergeQueue = true;
	}
	return result;
}

const settings = (repo: string, branch: string) =>
	`Set it in https://github.com/${repo}/settings/rules (a ruleset on ${branch}) or under Branches.`;

/** Checks the platform half of the review pipeline: what only GitHub can enforce. */
export async function githubLines(config: Config, gh: Gh): Promise<Line[]> {
	let repo = "";
	try {
		repo = (
			await gh([
				"repo",
				"view",
				"--json",
				"nameWithOwner",
				"-q",
				".nameWithOwner",
			])
		).trim();
	} catch (error) {
		return [
			{
				ok: false,
				text: `Cannot read the GitHub repo through \`gh\`: ${(error as Error).message}. Install gh and run \`gh auth login\`.`,
			},
		];
	}
	const branch = config.git.protected_branch ?? "main";
	const protection = await readProtection(gh, repo, branch);
	const fix = settings(repo, branch);
	if (!protection.found)
		return [
			{
				ok: false,
				text: `${repo}: ${branch} has no branch protection or ruleset, so anyone can merge anything. ${fix}`,
			},
		];
	const lines: Line[] = [
		protection.approvals >= 1
			? {
					ok: true,
					text: `${branch} needs ${protection.approvals} approval${protection.approvals === 1 ? "" : "s"}.`,
				}
			: {
					ok: false,
					text: `${branch} merges without an approval. Require at least one. ${fix}`,
				},
		protection.dismissStale
			? {
					ok: true,
					text: "A new push dismisses old approvals, so an approval covers the commit it saw.",
				}
			: {
					ok: false,
					text: `Approvals survive new pushes, so code nobody approved can merge. Turn on "Dismiss stale approvals". ${fix}`,
				},
		protection.threads
			? { ok: true, text: "Every review thread must be resolved before merge." }
			: {
					ok: false,
					text: `Review threads can stay open at merge, so a finding can be ignored. Turn on "Require conversation resolution". ${fix}`,
				},
	];
	const owners = config.risk.paths.some((entry) => entry.owners.length > 0);
	if (owners)
		lines.push(
			protection.codeOwners
				? { ok: true, text: "Code owners must approve changes to their paths." }
				: {
						ok: false,
						text: `[risk] names owners, but GitHub does not require their review. Turn on "Require review from Code Owners". ${fix}`,
					},
		);
	if (config.ci.github) {
		const wanted = ["checks", ...(config.ci.review ? ["review"] : [])];
		for (const name of wanted)
			lines.push(
				protection.checks.includes(name)
					? { ok: true, text: `The \`${name}\` job is a required check.` }
					: {
							ok: false,
							text: `The \`${name}\` job from the guardwright workflow is not a required check, so a red run can still merge. Add it under required status checks. ${fix}`,
						},
			);
	}
	lines.push(
		protection.mergeQueue
			? {
					ok: true,
					text: "A merge queue tests each change on top of the latest main.",
				}
			: {
					ok: true,
					text: `No merge queue. Optional: one tests each change against the latest ${branch} before it lands.`,
				},
	);
	return lines;
}
