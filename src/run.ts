export type RunResult = {
	ok: boolean;
	/** stdout and stderr together, for people to read. */
	output: string;
	stdout: string;
	stderr?: string;
	exitCode?: number | null;
	ms: number;
	timedOut: boolean;
	admission?: "deferred" | "load-tainted";
};

export type RunOptions = {
	timeoutMs?: number;
	processGroup?: boolean;
	env?: Record<string, string | undefined>;
	stdin?: string;
	inherit?: boolean;
	onSpawn?: (pid: number) => void;
};

const quiet = { NO_COLOR: "1", FORCE_COLOR: "0" };

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
	try {
		const { timeoutMs } = options;
		const processGroup =
			process.platform !== "win32" &&
			(options.processGroup || timeoutMs !== undefined);
		const child = Bun.spawn(argv, {
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
		options.onSpawn?.(child.pid);
		const out = child.stdout ? capture(child.stdout) : undefined;
		const err = child.stderr ? capture(child.stderr) : undefined;
		const completed = Promise.all([out?.done, err?.done, child.exited]).then(
			([, , code]) => code,
		);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const exitCode =
			timeoutMs === undefined
				? await completed
				: await Promise.race([
						completed,
						new Promise<null>((resolve) => {
							timer = setTimeout(
								() => resolve(null),
								Math.max(0, timeoutMs - (performance.now() - started)),
							);
						}),
					]).finally(() => clearTimeout(timer));
		const timedOut = exitCode === null;
		if (timedOut) {
			try {
				if (processGroup) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {
				if (child.exitCode === null) child.kill("SIGKILL");
			}
			// A process outside the group can still hold an inherited pipe.
			void Promise.allSettled([out?.cancel(), err?.cancel()]);
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
			ms,
			timedOut,
		};
	} catch (error) {
		return {
			ok: false,
			output: `Could not start \`${argv.join(" ")}\`: ${(error as Error).message}`,
			stdout: "",
			stderr: "",
			exitCode: null,
			ms: Math.round(performance.now() - started),
			timedOut: false,
		};
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
