import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config/schema";
import { gitContext } from "./git";
import { commandReasons } from "./guards/command";
import { render } from "./guards/finding";
import { branchFinding, commitMessageFinding } from "./guards/names";
import { run, runShell } from "./run";

export const gitHookNames = ["commit-msg", "pre-push"] as const;
export type GitHookName = (typeof gitHookNames)[number];

export type GitHookResult = { ok: boolean; messages: string[] };

const zero = /^0+$/;

function skipped(config: Config, env: Record<string, string | undefined>) {
	const value = env[config.git.skip_env];
	return value !== undefined && value !== "" && value !== "0";
}

export function commitMsg(
	messageFile: string,
	config: Config,
	env = process.env,
): GitHookResult {
	if (skipped(config, env)) return { ok: true, messages: [] };
	const finding = commitMessageFinding(
		readFileSync(messageFile, "utf8"),
		config,
	);
	return finding
		? { ok: false, messages: [render(finding)] }
		: { ok: true, messages: [] };
}

type PushedRef = {
	localRef: string;
	localSha: string;
	remoteRef: string;
	remoteSha: string;
};

export function parsePushLines(stdin: string): PushedRef[] {
	return stdin
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.filter((parts) => parts.length === 4)
		.map(([localRef, localSha, remoteRef, remoteSha]) => ({
			localRef: localRef as string,
			localSha: localSha as string,
			remoteRef: remoteRef as string,
			remoteSha: remoteSha as string,
		}));
}

// Git sets these for hooks; a pre_push command that runs git in another repo must not inherit them.
const gitEnv = {
	GIT_DIR: undefined,
	GIT_WORK_TREE: undefined,
	GIT_INDEX_FILE: undefined,
};

/** Starts `cagr <args>` detached, so the push goes on while it runs. Output goes to `log`. */
export type StartInBackground = (
	args: string[],
	cwd: string,
	log: string,
) => void;

// A compiled cagr is one binary; from source it is bun plus the entry file.
const self = () =>
	Bun.main.startsWith("/$bunfs/") || Bun.main.includes("~BUN")
		? [process.execPath]
		: [process.execPath, Bun.main];

export const startInBackground: StartInBackground = (args, cwd, log) => {
	mkdirSync(dirname(log), { recursive: true });
	const out = openSync(log, "a");
	const env = { ...process.env };
	for (const key of Object.keys(gitEnv)) delete env[key];
	const [command, ...rest] = self();
	spawn(command as string, [...rest, ...args], {
		cwd,
		env,
		detached: true,
		stdio: ["ignore", out, out],
	}).unref();
};

export async function prePush(
	stdin: string,
	config: Config,
	cwd: string,
	env = process.env,
	start: StartInBackground = startInBackground,
): Promise<GitHookResult> {
	if (skipped(config, env)) return { ok: true, messages: [] };
	const messages: string[] = [];
	const pushed: { branch: string; sha: string }[] = [];
	for (const ref of parsePushLines(stdin)) {
		const branch = ref.remoteRef.replace(/^refs\/heads\//, "");
		const isBranch = ref.remoteRef.startsWith("refs/heads/");
		if (isBranch && branch === config.git.protected_branch) {
			messages.push(
				render({
					id: "protected-branch",
					reason: commandReasons.pushProtected(config),
				}),
			);
			continue;
		}
		if (zero.test(ref.localSha)) continue;
		if (
			config.git.block_force_push &&
			!zero.test(ref.remoteSha) &&
			!(await fastForward(ref, cwd))
		)
			messages.push(
				render({
					id: "force-push",
					reason: `${ref.remoteRef} on the remote has commits that this push would drop. Pull and rebase or merge, then push without force.`,
				}),
			);
		if (isBranch) {
			const finding = branchFinding(branch, config);
			if (finding) messages.push(render(finding));
			pushed.push({
				branch: ref.localRef.startsWith("refs/heads/")
					? ref.localRef.slice("refs/heads/".length)
					: branch,
				sha: ref.localSha,
			});
		}
	}
	if (messages.length > 0) return { ok: false, messages };
	for (const command of config.git.pre_push) {
		const result = await runShell(command, config.root, { env: gitEnv });
		if (!result.ok)
			return {
				ok: false,
				messages: [
					`\`${command}\` failed, so the push was stopped.\n${result.output.trimEnd()}`,
				],
			};
	}
	if (!config.review.status || pushed.length === 0)
		return { ok: true, messages: [] };
	return { ok: true, messages: await sendStatuses(config, cwd, pushed, start) };
}

/**
 * GitHub has not seen the commits yet while this hook runs, so a background
 * `cagr post-status` waits for the push to land, then sets the statuses.
 * Never stops the push.
 */
async function sendStatuses(
	config: Config,
	cwd: string,
	pushed: { branch: string; sha: string }[],
	start: StartInBackground,
): Promise<string[]> {
	try {
		const git = await gitContext(cwd);
		if (!git.commonDir) return [];
		// The pre_push commands ran on the working tree, so they vouch only for a clean HEAD.
		const clean =
			config.git.pre_push.length > 0 &&
			(
				await run(
					["git", "status", "--porcelain", "--untracked-files=no"],
					cwd,
					{
						env: gitEnv,
					},
				)
			).output.trim() === "";
		const log = join(git.commonDir, "cagr", "status.log");
		for (const { branch, sha } of pushed)
			start(
				[
					"post-status",
					sha,
					"--branch",
					branch,
					"--wait",
					"120",
					...(clean && sha === git.head ? ["--checks"] : []),
				],
				config.root,
				log,
			);
		return [
			`sending the GitHub commit status${pushed.length === 1 ? "" : "es"} once the push lands. If ${pushed.length === 1 ? "it does" : "they do"} not show up, read ${log}.`,
		];
	} catch (error) {
		return [
			`did not send the GitHub commit statuses: ${(error as Error).message}. Run \`cagr review\` after the push to send cagr/review.`,
		];
	}
}

// A remote commit this clone has never fetched cannot be judged; the server decides.
async function fastForward(ref: PushedRef, cwd: string) {
	const known = await run(
		["git", "cat-file", "-e", `${ref.remoteSha}^{commit}`],
		cwd,
		{ env: gitEnv },
	);
	if (!known.ok) return true;
	return (
		await run(
			["git", "merge-base", "--is-ancestor", ref.remoteSha, ref.localSha],
			cwd,
			{ env: gitEnv },
		)
	).ok;
}
