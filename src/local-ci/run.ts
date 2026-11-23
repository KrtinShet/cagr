import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ci, ciReport } from "../ci";
import { defaultCiInstall, loadConfig } from "../config/load";
import type { Config } from "../config/schema";
import { stackDir, stackInstall } from "../github-files";
import { claudeAgent } from "../review/agent";
import { ciReview, type Gh, ghAt, type PullRequest } from "../review/github";
import { checksContext, postStatus, reviewContext } from "../review/status";
import { run, shellArgv } from "../run";
import { LocalCiError, lockWatch, makeCache, type WatchPaths } from "./cache";

const loginEnv = {
	GH_TOKEN: undefined,
	GITHUB_TOKEN: undefined,
	GH_ENTERPRISE_TOKEN: undefined,
	GITHUB_ENTERPRISE_TOKEN: undefined,
	GH_HOST: undefined,
	GH_PROMPT_DISABLED: "1",
	GIT_TERMINAL_PROMPT: "0",
	ANTHROPIC_API_KEY: undefined,
	ANTHROPIC_AUTH_TOKEN: undefined,
	CLAUDE_CODE_OAUTH_TOKEN: undefined,
	CLAUDECODE: undefined,
};

const localRun: typeof run = (argv, cwd, options) =>
	run(argv, cwd, {
		...options,
		processGroup: options?.processGroup ?? process.platform !== "win32",
		env: { ...options?.env, ...loginEnv },
	});

type Runtime = {
	gh: Gh;
	run: typeof run;
	log: (line: string) => void;
};

type PrDetails = {
	number: number;
	state: string;
	isDraft: boolean;
	isCrossRepository: boolean;
	author: { login?: string } | null;
	headRepository: { name: string } | null;
	headRepositoryOwner: { login: string } | null;
	headRefName: string;
	headRefOid: string;
	baseRefName: string;
	body: string;
	title: string;
};

const fields =
	"number,state,isDraft,isCrossRepository,author,headRepository,headRepositoryOwner,headRefName,headRefOid,baseRefName,body,title";

async function repository(gh: Gh) {
	const repo = JSON.parse(
		await gh(["repo", "view", "--json", "nameWithOwner,url"]),
	) as { nameWithOwner: string; url: string };
	if (
		!/^https:\/\/github\.com\//i.test(repo.url) ||
		!/^[-\w.]+\/[-\w.]+$/.test(repo.nameWithOwner)
	)
		throw new LocalCiError("Use a github.com checkout for cagr local CI.");
	return repo.nameWithOwner;
}

async function refusal(gh: Gh, repo: string, pr: PrDetails) {
	const headRepo = `${pr.headRepositoryOwner?.login}/${pr.headRepository?.name}`;
	if (
		pr.isCrossRepository !== false ||
		headRepo.toLowerCase() !== repo.toLowerCase()
	)
		return "Head is from another repository. Run local CI only on same-repo pull requests.";
	const login = pr.author?.login;
	if (!login)
		return "Author is missing. Ask a collaborator with write access to open the pull request.";
	const permission = (
		await gh([
			"api",
			`repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
			"--jq",
			".permission",
		])
	).trim();
	if (!["admin", "maintain", "write"].includes(permission))
		return `${login} lacks write access. Ask a collaborator with write access to open the pull request.`;
	return null;
}

async function pendingTasks(gh: Gh, repo: string, sha: string) {
	const statuses = (
		await gh([
			"api",
			"--paginate",
			`repos/${repo}/commits/${sha}/statuses?per_page=100`,
			"--jq",
			".[] | [(.context | ascii_downcase), .state] | @tsv",
		])
	).split(/\r?\n/);
	const succeeded = (context: string) =>
		statuses.find((status) => status.startsWith(`${context}\t`)) ===
		`${context}\tsuccess`;
	return {
		checks: !succeeded(checksContext),
		review: !succeeded(reviewContext),
	};
}

function installs(config: Config) {
	if (config.ci.install !== defaultCiInstall)
		return [{ command: config.ci.install, cwd: config.root }];
	const commands = new Map<string, { command: string; cwd: string }>();
	for (const stack of config.stack) {
		const command = stackInstall(stack);
		if (!command) continue;
		const cwd = join(config.root, stackDir(stack));
		commands.set(`${cwd}\0${command}`, { command, cwd });
	}
	return commands.values();
}

async function checkPullRequest(
	pr: PullRequest,
	details: PrDetails,
	cache: string,
	runtime: Runtime,
	tasks: { checks: boolean; review: boolean },
) {
	const { gh, run: execute, log } = runtime;
	makeCache(cache);
	const scratch = mkdtempSync(join(cache, "pr-"));
	const gitDir = join(scratch, "git");
	const worktree = join(scratch, "checkout");
	const reviewTree = join(scratch, "review");
	const checked = async (argv: string[], cwd: string, timeoutMs = 60_000) => {
		const result = await execute(argv, cwd, { timeoutMs });
		if (!result.ok)
			throw new LocalCiError(
				`${argv.join(" ")} failed. Fix the command and rerun cagr ci --pr ${pr.number}.\n${result.output.trim()}`,
			);
		return result.stdout.trim();
	};
	const git = (...args: string[]) =>
		checked(["git", `--git-dir=${gitDir}`, ...args], scratch, 300_000);
	const post = async (
		context: string,
		ok: boolean,
		description: string,
		deferred = false,
	) => {
		const result = await postStatus(
			gh,
			pr.head,
			{
				context,
				state: ok ? "success" : deferred ? "pending" : "failure",
				description,
			},
			pr.repo,
		);
		log(result.message);
		return result.ok;
	};
	const readConfig = (cwd: string) => {
		const config = loadConfig(cwd);
		if (!config || config.root !== cwd)
			throw new LocalCiError(
				"Add cagr config at the PR checkout root, then rerun local CI.",
			);
		return config;
	};
	try {
		await checked(["git", "init", "--bare", "--template=", gitDir], scratch);
		await git("config", "core.hooksPath", "/dev/null");
		await git("remote", "add", "origin", `https://github.com/${pr.repo}.git`);
		await git(
			"-c",
			"credential.helper=",
			"-c",
			"credential.https://github.com.helper=!gh auth git-credential",
			"fetch",
			"--no-tags",
			"origin",
			`refs/pull/${pr.number}/head:refs/cagr/head`,
			`refs/heads/${pr.base}:refs/remotes/origin/${pr.base}`,
		);
		if ((await git("rev-parse", "refs/cagr/head")) !== pr.head) {
			log(
				`PR #${pr.number} changed before checkout. Rerun cagr ci --pr ${pr.number} for the new head.`,
			);
			return false;
		}
		let ok = true;
		if (tasks.checks) {
			let checksOk = false;
			let deferred = false;
			try {
				await git("worktree", "add", "--detach", worktree, pr.head);
				const config = readConfig(worktree);
				for (const { command, cwd } of installs(config))
					await checked(shellArgv(command), cwd, 900_000);
				const result = await ci(config, {
					cwd: worktree,
					base: pr.base,
					pr: {
						head: { sha: pr.head },
						branch: details.headRefName,
						body: pr.body,
						title: details.title,
					},
					env: {},
					executeCheck: execute,
				});
				log(ciReport(result));
				checksOk = result.ok;
				deferred =
					!checksOk &&
					result.checks.every((entry) => entry.ok || entry.deferred);
			} catch (error) {
				log((error as Error).message);
			}
			const sent = await post(
				checksContext,
				checksOk,
				checksOk
					? "Local CI checks passed."
					: deferred
						? "Local CI checks deferred under load. Rerun when the machine is quieter."
						: "Local CI checks failed. See the watch log or rerun cagr ci --pr.",
				deferred,
			);
			ok = checksOk && sent;
		}
		if (tasks.review) {
			let reviewOk = false;
			try {
				// Checks can change files. Review a fresh checkout of the exact head.
				await git("worktree", "add", "--detach", reviewTree, pr.head);
				const login = (await gh(["api", "user", "--jq", ".login"])).trim();
				if (!login)
					throw new LocalCiError("Run gh auth login before local CI.");
				const result = await ciReview(readConfig(reviewTree), reviewTree, {
					local: { pr, login },
					gh,
					agent: claudeAgent(execute),
					progress: log,
				});
				log(result.report);
				reviewOk = result.ok && result.complete;
			} catch (error) {
				log((error as Error).message);
			}
			const sent = await post(
				reviewContext,
				reviewOk,
				reviewOk
					? "Local CI review passed."
					: "Local CI review failed. See the PR and the watch log.",
			);
			ok = ok && reviewOk && sent;
		}
		return ok;
	} finally {
		// The worktrees and their private Git metadata are all under scratch.
		rmSync(scratch, { recursive: true, force: true });
	}
}

export async function localCi(
	config: Config,
	paths: WatchPaths,
	mode: "watch" | number,
	runtime: Runtime = {
		gh: ghAt(config.root, localRun),
		run: localRun,
		log: (line) => console.log(line),
	},
): Promise<boolean> {
	const lock = lockWatch(paths.cache);
	if (!lock) {
		runtime.log("Local CI is already running for this repo.");
		return mode === "watch";
	}
	const { gh, log } = runtime;
	try {
		if (mode === "watch") {
			const now = new Date().toISOString();
			writeFileSync(paths.lastRun, `${now}\n`);
			log(`${now} Local CI watch pass.`);
		}
		const repo = await repository(gh);
		const prs =
			mode === "watch"
				? (JSON.parse(
						await gh([
							"pr",
							"list",
							"--state",
							"open",
							"--limit",
							"2147483647",
							"--repo",
							repo,
							"--json",
							"number,isDraft,headRefOid",
						]),
					) as Pick<PrDetails, "number" | "isDraft" | "headRefOid">[])
				: [{ number: mode, isDraft: false, headRefOid: "" }];
		let ok = true;
		const seen = new Set<string>();
		for (const { number, isDraft, headRefOid } of prs) {
			if (mode === "watch" && isDraft) continue;
			try {
				let tasks = { checks: true, review: true };
				if (mode === "watch" && /^[a-f0-9]{40}$/.test(headRefOid)) {
					if (seen.has(headRefOid)) continue;
					tasks = await pendingTasks(gh, repo, headRefOid);
					if (!tasks.checks && !tasks.review) continue;
				}
				const details = JSON.parse(
					await gh([
						"pr",
						"view",
						String(number),
						"--repo",
						repo,
						"--json",
						fields,
					]),
				) as PrDetails;
				if (details.state !== "OPEN") {
					if (mode !== "watch")
						throw new LocalCiError(
							"Use cagr ci --pr with an open pull request.",
						);
					continue;
				}
				if (mode === "watch" && details.isDraft) continue;
				const head = details.headRefOid;
				if (!/^[a-f0-9]{40}$/.test(head))
					throw new LocalCiError(
						`PR #${number} has no valid head. Check its head on GitHub and retry.`,
					);
				if (mode === "watch" && head !== headRefOid) {
					if (seen.has(head)) continue;
					tasks = await pendingTasks(gh, repo, head);
					if (!tasks.checks && !tasks.review) continue;
				}
				const reason = await refusal(gh, repo, details);
				if (reason) {
					log(`Refused PR #${number}. ${reason}`);
					if (mode !== "watch") ok = false;
					continue;
				}
				log(`Running local CI for PR #${number} at ${head.slice(0, 7)}.`);
				const passed = await checkPullRequest(
					{
						number,
						repo,
						head,
						base: details.baseRefName,
						body: details.body ?? "",
					},
					details,
					paths.cache,
					runtime,
					tasks,
				);
				if (!passed) ok = false;
				// A second PR can point at the same SHA before GitHub returns a posted status.
				seen.add(head);
			} catch (error) {
				log(`PR #${number}: ${(error as Error).message}`);
				ok = false;
			}
		}
		return ok;
	} finally {
		lock.close();
	}
}
