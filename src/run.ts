export type RunResult = {
	ok: boolean;
	output: string;
	ms: number;
	timedOut: boolean;
};

export type RunOptions = {
	timeoutMs?: number;
	env?: Record<string, string | undefined>;
	stdin?: string;
};

const quiet = { NO_COLOR: "1", FORCE_COLOR: "0" };

export async function run(
	argv: string[],
	cwd: string,
	options: RunOptions = {},
): Promise<RunResult> {
	const started = performance.now();
	try {
		const child = Bun.spawn(argv, {
			cwd,
			stdin:
				options.stdin === undefined
					? "ignore"
					: new TextEncoder().encode(options.stdin),
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, ...quiet, ...options.env },
			timeout: options.timeoutMs,
			killSignal: "SIGKILL",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		const timedOut =
			child.signalCode === "SIGKILL" && options.timeoutMs !== undefined;
		const ms = Math.round(performance.now() - started);
		const output = timedOut
			? `${stdout}${stderr}\nStopped after ${options.timeoutMs} ms. Make the check faster or narrow it with {files}.`
			: `${stdout}${stderr}`;
		return { ok: exitCode === 0, output, ms, timedOut };
	} catch (error) {
		return {
			ok: false,
			output: `Could not start \`${argv.join(" ")}\`: ${(error as Error).message}`,
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
