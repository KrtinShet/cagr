import { readFileSync } from "node:fs";
import type { Config } from "./config/schema";
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

export async function prePush(
	stdin: string,
	config: Config,
	cwd: string,
	env = process.env,
): Promise<GitHookResult> {
	if (skipped(config, env)) return { ok: true, messages: [] };
	const messages: string[] = [];
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
	return { ok: true, messages: [] };
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
