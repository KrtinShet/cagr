export type RunResult = {
	ok: boolean;
	/** stdout and stderr together, for people to read. */
	output: string;
	stdout: string;
	stderr?: string;
	exitCode?: number | null;
	signal?: NodeJS.Signals | number;
	startError?: true;
	ms: number;
	timedOut: boolean;
	admission?: "deferred" | "load-tainted";
};

export type RunOptions = {
	timeoutMs?: number;
	processGroup?: boolean;
	waitForGroup?: boolean;
	closePipesAfterExit?: boolean;
	cleanupHandoff?: () =>
		| { deadline: number; keepWatching: () => void }
		| undefined;
	log?: (line: string) => void;
	env?: Record<string, string | undefined>;
	stdin?: string;
	inherit?: boolean;
	onSpawn?: (pid: number) => void;
};

const quiet = { NO_COLOR: "1", FORCE_COLOR: "0" };
const groupGraceMs = 10_000;
const killGraceMs = 250;
const pipeGraceMs = 1000;
export const cleanupLimitMs = 120_000;

function within<T>(promise: Promise<T>, ms: number) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<null>((resolve) => {
			timer = setTimeout(() => resolve(null), Math.max(0, ms));
		}),
	]).finally(() => clearTimeout(timer));
}

function signalGroup(pid: number, signal: NodeJS.Signals | 0) {
	try {
		process.kill(-pid, signal);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		if (code !== "EPERM") throw error;
		// macOS can return EPERM for an orphaned group whose members are all zombies.
		const snapshot = Bun.spawnSync(["/bin/ps", "-axo", "pgid=,stat="], {
			timeout: 500,
			stderr: "ignore",
		});
		return (
			!snapshot.success ||
			snapshot.stdout
				.toString()
				.split("\n")
				.some((line) => {
					const [group, state] = line.trim().split(/\s+/);
					return Number(group) === pid && !state?.startsWith("Z");
				})
		);
	}
}

async function waitForGroupExit(pid: number, deadline: number) {
	while (signalGroup(pid, 0)) {
		const remaining = deadline - performance.now();
		if (remaining <= 0) return false;
		await Bun.sleep(Math.min(50, remaining));
	}
	return true;
}

function capture(stream: ReadableStream<Uint8Array>) {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	return {
		done: (async () => {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				text += decoder.decode(value, { stream: true });
			}
			text += decoder.decode();
		})(),
		text: () => text,
		cancel: () => reader.cancel(),
	};
}

export async function run(
	argv: string[],
	cwd: string,
	options: RunOptions = {},
): Promise<RunResult> {
	const started = performance.now();
	const { timeoutMs } = options;
	const processGroup =
		process.platform !== "win32" &&
		(options.processGroup ?? timeoutMs !== undefined);
	let child: Bun.Subprocess<
		"ignore" | "inherit" | Uint8Array,
		"pipe" | "inherit",
		"pipe" | "inherit"
	>;
	try {
		child = Bun.spawn(argv, {
			cwd,
			stdin:
				options.stdin === undefined
					? options.inherit
						? "inherit"
						: "ignore"
					: new TextEncoder().encode(options.stdin),
			stdout: options.inherit ? "inherit" : "pipe",
			stderr: options.inherit ? "inherit" : "pipe",
			env: {
				...process.env,
				...(options.inherit ? {} : quiet),
				...options.env,
			},
			detached: processGroup,
		});
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return {
			ok: false,
			output: `Could not start \`${argv.join(" ")}\`: ${(error as Error).message}`,
			stdout: "",
			stderr: "",
			exitCode:
				code === "ENOENT"
					? 127
					: code === "EACCES" ||
							code === "EPERM" ||
							code === "ENOEXEC" ||
							code === "EISDIR"
						? 126
						: null,
			startError: true,
			ms: Math.round(performance.now() - started),
			timedOut: false,
		};
	}
	const drain = processGroup && options.waitForGroup;
	const finishOnExit = drain || options.closePipesAfterExit;
	const log = options.log ?? console.error;
	const kill = async () => {
		if (
			(!processGroup || !signalGroup(child.pid, "SIGKILL")) &&
			child.exitCode === null
		)
			child.kill("SIGKILL");
		const deadline = performance.now() + killGraceMs;
		await within(child.exited, killGraceMs);
		if (!drain || (await waitForGroupExit(child.pid, deadline))) return;
		const limit = performance.now() + cleanupLimitMs;
		const handoff = options.cleanupHandoff?.();
		log(
			`cagr: process group ${child.pid} is still alive after SIGKILL. Holding its admission tokens while it drains.`,
		);
		if (
			await waitForGroupExit(
				child.pid,
				Math.min(limit, handoff?.deadline ?? limit),
			)
		)
			return;
		if (handoff && handoff.deadline < limit) handoff.keepWatching();
		else
			log(
				`cagr: WARNING: process group ${child.pid} is still alive after the cleanup deadline. Releasing its admission tokens. Inspect and stop the remaining processes.`,
			);
	};
	try {
		options.onSpawn?.(child.pid);
		const out = child.stdout ? capture(child.stdout) : undefined;
		const err = child.stderr ? capture(child.stderr) : undefined;
		const streams = Promise.all([out?.done, err?.done]);
		const completed = finishOnExit
			? child.exited
			: Promise.all([streams, child.exited]).then(([, code]) => code);
		const exitCode =
			timeoutMs === undefined
				? await completed
				: await within(completed, started + timeoutMs - performance.now());
		const timedOut = exitCode === null;
		if (timedOut) {
			await kill();
		} else if (finishOnExit) {
			// Descendants can inherit the pipes even after the main process exits.
			await within(
				streams,
				Math.min(
					pipeGraceMs,
					started + (timeoutMs ?? Infinity) - performance.now(),
				),
			);
		}
		if (timedOut || finishOnExit)
			void Promise.allSettled([out?.cancel(), err?.cancel()]);
		if (!timedOut && drain) {
			const empty = await waitForGroupExit(
				child.pid,
				Math.min(
					performance.now() + groupGraceMs,
					started + (timeoutMs ?? Infinity),
				),
			);
			if (!empty) await kill();
		}
		const stdout = out?.text() ?? "";
		const stderr = err?.text() ?? "";
		const ms = Math.round(performance.now() - started);
		const output = timedOut
			? `${stdout}${stderr}\nStopped after ${timeoutMs} ms. Make the check faster or narrow it with {files}.`
			: `${stdout}${stderr}`;
		return {
			ok: exitCode === 0 && !timedOut,
			output,
			stdout,
			stderr,
			exitCode,
			...(child.signalCode ? { signal: child.signalCode } : {}),
			ms,
			timedOut,
		};
	} catch (error) {
		await kill();
		throw error;
	}
}

export function shellArgv(command: string) {
	return process.platform === "win32"
		? ["cmd.exe", "/d", "/s", "/c", command]
		: ["sh", "-c", command];
}

export function runShell(
	command: string,
	cwd: string,
	options: RunOptions = {},
) {
	return run(shellArgv(command), cwd, options);
}

/** Quotes a path for `sh -c`, or for cmd.exe on Windows. */
export function shellQuote(word: string) {
	if (/^[\w@%+=:,./-]+$/.test(word)) return word;
	if (process.platform === "win32") return `"${word.replace(/"/g, '""')}"`;
	return `'${word.replace(/'/g, `'\\''`)}'`;
}
