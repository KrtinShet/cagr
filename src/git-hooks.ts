import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runAdmittedShell } from "./admission/run";
import type { Config } from "./config/schema";
import { gitContext, gitHookEnv } from "./git";
import { commandReasons, gitOptionsWithValue } from "./guards/command";
import { render } from "./guards/finding";
import { branchFinding, commitMessageFinding } from "./guards/names";
import { PushLeases } from "./leases/push";
import { leasePush, serialRef, useLeaseCommand } from "./leases/refs";
import { run } from "./run";

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

export type PushedRef = {
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
export const gitEnv = gitHookEnv;

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
	})
		// A start failure arrives as an event, not a throw: log it so the push still goes on.
		.on("error", (error) => {
			appendFileSync(
				log,
				`Could not start cagr post-status: ${error.message}\n`,
			);
		})
		.unref();
};

async function parentArgs(pid: number): Promise<string[]> {
	if (process.platform === "linux")
		return (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
	if (process.platform !== "darwin") return [];

	// KERN_PROCARGS2 returns argc, the executable path, padding, then argv.
	// ps joins arguments with spaces, which can make a config value look like a command.
	const { dlopen } = await import("bun:ffi");
	const lib = dlopen("/usr/lib/libSystem.B.dylib", {
		sysctl: {
			args: ["ptr", "u32", "ptr", "ptr", "ptr", "u64"],
			returns: "i32",
		},
	});
	try {
		const mib = new Int32Array([1, 49, pid]);
		const size = new BigUint64Array(1);
		const sysctl = lib.symbols.sysctl;
		if (sysctl(mib, mib.length, null, size, null, 0n) !== 0) return [];
		const bytes = Buffer.alloc(Number(size[0]));
		if (
			sysctl(mib, mib.length, bytes, size, null, 0n) !== 0 ||
			Number(size[0]) < 4
		)
			return [];
		const argc = bytes.readInt32LE(0);
		let offset = bytes.indexOf(0, 4);
		if (offset < 0) return [];
		while (bytes[offset] === 0) offset++;
		const args: string[] = [];
		for (let index = 0; index < argc; index++) {
			const end = bytes.indexOf(0, offset);
			if (end < 0 || end >= Number(size[0])) return [];
			args.push(bytes.toString("utf8", offset, end));
			offset = end + 1;
		}
		return args;
	} finally {
		lib.close();
	}
}

async function realPush() {
	const args = await parentArgs(process.ppid).catch(() => []);
	if (!/(?:^|\/)git$/.test(args[0] ?? "")) return false;
	let command = 1;
	for (let arg = args[command]; arg; arg = args[command]) {
		if (gitOptionsWithValue.has(arg)) command += 2;
		else if (
			/^(?:--(?:git-dir|work-tree|namespace|config-env)=|--no-pager$|--paginate$|-[pP]$)/.test(
				arg,
			)
		)
			command++;
		else break;
	}
	return (
		args[command] === "push" &&
		!args
			.slice(command + 1)
			.some(
				(arg) =>
					(arg.startsWith("--d") && "--dry-run".startsWith(arg)) ||
					/^-[^-]*n/.test(arg),
			)
	);
}

export async function prePush(
	stdin: string,
	config: Config,
	cwd: string,
	env = process.env,
	start: StartInBackground = startInBackground,
	remoteUrl?: string,
): Promise<GitHookResult> {
	const refs = parsePushLines(stdin);
	const serial = refs.filter(({ remoteRef }) =>
		remoteRef.startsWith(serialRef),
	);
	if (serial.length && env[leasePush] !== "1")
		return { ok: false, messages: [useLeaseCommand] };
	if (skipped(config, env)) return { ok: true, messages: [] };
	if (refs.length === serial.length) return { ok: true, messages: [] };
	const messages: string[] = [];
	const warnings: string[] = [];
	const leases = new PushLeases(config, cwd, messages, warnings);
	const writable = !config.lease.length || (await realPush());
	const pushed: { branch: string; sha: string }[] = [];
	for (const ref of refs) {
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
	try {
		await leases.inspect(refs, remoteUrl);
	} catch (error) {
		warnings.push(
			`Serial lease checks were incomplete: ${(error as Error).message}. Run cagr lease list and verify ownership before landing.`,
		);
	}
	let unchecked = false;
	if (!messages.length)
		await leases.verify(
			async () => {
				for (const command of config.git.pre_push) {
					if (messages.length) break;
					const result = await runAdmittedShell(
						command,
						config.root,
						config.admission,
						{
							env: { ...gitEnv, ...leases.priorityEnv },
							priority: "push",
							timeoutMs: 1_800_000,
							log: (line) => console.error(line),
						},
					).catch((error: unknown) => {
						unchecked = true;
						warnings.push(
							`Memory admission could not run \`${command}\`. ${error} Run the check before merging.`,
						);
						return null;
					});
					if (result?.admission) messages.push(result.output);
					else if (result && !result.ok)
						messages.push(
							`\`${command}\` failed, so the push was stopped.\n${result.output.trimEnd()}`,
						);
				}
			},
			config.git.pre_push.length > 0,
			writable,
		);
	if (messages.length > 0) {
		if (writable) await leases.releaseUnpublished();
		return { ok: false, messages: [...messages, ...warnings] };
	}
	if (
		!unchecked &&
		config.review.status &&
		pushed.length > 0 &&
		(!config.lease.length || writable)
	)
		warnings.push(...(await sendStatuses(config, cwd, pushed, start)));
	return { ok: true, messages: warnings };
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
		// The pre_push commands ran on the working tree, untracked files included, so they vouch only for a clean HEAD.
		const clean =
			config.lease.length === 0 &&
			config.git.pre_push.length > 0 &&
			(
				await run(
					["git", "status", "--porcelain", "--untracked-files=normal"],
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
			`did not send the GitHub commit statuses: ${(error as Error).message}. Run \`cagr post-status <sha> --branch <branch>\` to retry after the push.`,
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
