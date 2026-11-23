import { closeSync, openSync } from "node:fs";
import { totalmem } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Config } from "../config/schema";
import { gitContext } from "../git";
import {
	cleanupLimitMs,
	type RunOptions,
	type RunResult,
	run,
	shellArgv,
	shellQuote,
} from "../run";
import { classifyArgv } from "./classify";
import {
	cacheDir,
	describeTicket,
	Pool,
	type Priority,
	poolSize,
	type Ticket,
	ticketOrder,
} from "./pool";
import {
	dockerMemory,
	gib,
	type Pressure,
	pressureReader,
	supportsAdmission,
	usableMemory,
} from "./pressure";
import { canScope, memorySampler } from "./sample";

export type AdmissionOptions = RunOptions & {
	priority?: "push";
	execute?: typeof run;
	deadline?: number;
	pressure?: () => Pressure;
};

type Request = {
	argv: string[];
	cwd: string;
	config: Config["admission"];
	options: AdmissionOptions;
	measure: boolean;
};

const deferred = "load: turn-end checks deferred";
const tainted =
	"load-tainted: the command failed under elevated memory pressure. Rerun when the machine is quieter.";
const pollMs = 250;
const admissionWaitMs = 60_000;
export const reservationEnv = "CAGR_ADMISSION_HELD";

function unsettled(
	admission: NonNullable<RunResult["admission"]>,
	output: string,
): RunResult {
	return { admission, ok: false, output, stdout: "", ms: 0, timedOut: false };
}

// A pipe closes on SIGKILL as well as on a normal exit. A surviving command group
// must stop when the owner of its memory tokens disappears.
function watchOwner(pid: number, locks: number[], logPath?: string) {
	const checks = Math.ceil(cleanupLimitMs / pollMs);
	const logFd = logPath ? openSync(logPath, "a", 0o600) : undefined;
	const child = (() => {
		try {
			return Bun.spawn(
				[
					"/bin/sh",
					"-c",
					`IFS= read -r done && exit 0
/bin/kill -KILL -- "-$1" 2>/dev/null
tries=0
while /bin/kill -0 -- "-$1" 2>/dev/null; do
	if [ "$tries" -eq "$2" ]; then
		printf 'cagr: WARNING: process group %s is still alive after watchdog cleanup. Releasing its admission tokens. Inspect and stop the remaining processes.\\n' "$1" >&2
		break
	fi
	sleep 0.25
	tries=$((tries + 1))
done`,
					"cagr-watch",
					String(pid),
					String(checks),
				],
				{
					stdio: ["pipe", "ignore", logFd ?? "inherit", ...locks],
					detached: true,
				},
			);
		} finally {
			if (logFd !== undefined) closeSync(logFd);
		}
	})();
	return async (keepWatching: boolean) => {
		if (keepWatching) child.unref();
		else child.stdin.write("done\n");
		await child.stdin.end();
		if (!keepWatching) await child.exited;
	};
}

async function execute(
	request: Request,
	pressure: () => Pressure,
	tokens: number,
	heavy: boolean,
	locks: number[],
	marker?: string,
) {
	const { argv, cwd, options, measure } = request;
	const scope = (heavy || measure) && (await canScope(cwd));
	if (!scope && (heavy || measure) && process.platform === "linux")
		options.log?.(
			"cagr: running without a systemd scope. Enable user scopes on systemd 254 or later to use a memory ceiling with literal arguments.",
		);
	const unit = scope ? `cagr-${crypto.randomUUID()}.scope` : undefined;
	const command = unit
		? [
				"systemd-run",
				"--user",
				"--scope",
				"--quiet",
				"--expand-environment=no",
				`--unit=${unit}`,
				"-p",
				"OOMPolicy=kill",
				...(heavy && !measure ? ["-p", `MemoryMax=${tokens}G`] : []),
				"--",
				"/bin/sh",
				"-c",
				'exec "$@"',
				"cagr-scope",
				...argv,
			]
		: argv;
	let elevated = false;
	let samplingError: unknown;
	const samplePressure = () => {
		try {
			if (pressure().elevated) elevated = true;
		} catch (error) {
			samplingError = error;
		}
	};
	samplePressure();
	const limit = runLimit(options);
	if (limit <= 0)
		return { result: unsettled("deferred", deferred), elevated: false };
	const timer = setInterval(samplePressure, pollMs);
	let sample: ReturnType<typeof memorySampler> | undefined;
	let stopWatch: ReturnType<typeof watchOwner> | undefined;
	let keepWatching = false;
	const cleanupLog =
		locks.length && options.deadline !== undefined
			? join(cacheDir(), "cleanup.log")
			: undefined;
	try {
		const result = await (options.execute ?? run)(command, cwd, {
			...options,
			env: marker ? { ...options.env, [reservationEnv]: marker } : options.env,
			timeoutMs: Number.isFinite(limit)
				? Math.max(1, Math.floor(limit))
				: undefined,
			processGroup: true,
			waitForGroup: true,
			cleanupHandoff: () => {
				const { deadline } = options;
				if (!stopWatch || !cleanupLog || deadline === undefined) return;
				return {
					deadline,
					keepWatching: () => {
						keepWatching = true;
						options.log?.(
							`cagr: the watchdog is retaining the tokens after the hook deadline. Cleanup warnings go to ${cleanupLog}.`,
						);
					},
				};
			},
			onSpawn: (pid) => {
				options.onSpawn?.(pid);
				if (locks.length || options.inherit)
					stopWatch = watchOwner(pid, locks, cleanupLog);
				if (measure) sample = memorySampler(pid, unit);
			},
		});
		samplePressure();
		if (samplingError)
			options.log?.(`cagr: memory monitoring error. ${samplingError}`);
		return { result, elevated, peak: sample?.() };
	} finally {
		clearInterval(timer);
		await stopWatch?.(keepWatching);
	}
}

async function admit(
	pool: Pool,
	ticket: Ticket,
	request: Request,
	keys: { current: string; legacy: string },
	pressure: () => Pressure,
) {
	const { config, measure, options } = request;
	const deadline = Math.min(
		options.deadline ?? Infinity,
		performance.now() + admissionWaitMs,
	);
	let last = "";
	const ownership: { fd?: number } = {};
	try {
		while (performance.now() < deadline) {
			const snapshot = await pool.transaction(deadline, () => {
				const entries = pool.list();
				if (ownership.fd === undefined) {
					ownership.fd = pool.own(ticket);
					ticket.order =
						Math.max(0, ...entries.map((entry) => entry.order)) + 1;
					ticket.since = Date.now();
					pool.save(ticket);
					entries.push(ticket);
					entries.sort(ticketOrder);
				}
				const queue = entries.filter((entry) => entry.slots.length === 0);
				const index = queue.findIndex((entry) => entry.id === ticket.id);
				const costs = pool.costs();
				const size = poolSize(config, costs);
				const peak = measure
					? undefined
					: (costs?.peaks[keys.current] ?? costs?.peaks[keys.legacy]);
				const tokens = peak ? Math.ceil(peak / gib) : size;
				if (tokens > size)
					return {
						blocked: `load: the measured command needs ${tokens} tokens and this pool has ${size}. Free memory and run cagr measure again, or raise admission.pool_tokens if it capped the pool.`,
					};
				if (index > 0)
					return {
						message: `load: queue #${index + 1}, behind ${queue.slice(0, index).map(describeTicket).join("; ")}`,
					};
				const current = pressure();
				if (
					current.elevated ||
					(current.available !== undefined && current.available < tokens * gib)
				)
					return {
						message: `load: queue #1, waiting for ${tokens} GiB and normal pressure (${current.description})`,
					};
				const held = entries.filter((entry) => entry.slots.length > 0);
				const reserved = pool.reserve(ticket, held, size, tokens);
				return reserved
					? { ...reserved, tokens, current }
					: {
							message: `load: queue #1, waiting for tokens held by ${held.map(describeTicket).join("; ") || "another command"}`,
						};
			});
			if (!snapshot) break;
			if (snapshot.blocked) return snapshot.blocked;
			if ("release" in snapshot && ownership.fd !== undefined) {
				const fd = ownership.fd;
				ownership.fd = undefined;
				return {
					...snapshot,
					locks: [...snapshot.locks, fd],
					release: () => {
						snapshot.release();
						pool.remove(ticket, fd);
					},
				};
			}
			if (snapshot.message && last !== snapshot.message) {
				last = snapshot.message;
				options.log?.(last);
			}
			await Bun.sleep(
				Math.min(pollMs, Math.max(0, deadline - performance.now())),
			);
		}
	} finally {
		if (ownership.fd !== undefined) pool.remove(ticket, ownership.fd);
	}
}

function runLimit(options: AdmissionOptions) {
	const remaining =
		options.deadline === undefined
			? Infinity
			: options.deadline - performance.now();
	return Math.min(options.timeoutMs ?? Infinity, remaining);
}

function priority(options: AdmissionOptions): Priority {
	const value = options.env?.CAGR_PRIORITY ?? process.env.CAGR_PRIORITY;
	return value === "lease"
		? "lease"
		: (options.priority ?? (value === "push" ? "push" : "normal"));
}

function loadTainted(result: RunResult, elevated: boolean) {
	return (
		elevated &&
		(result.timedOut || result.signal === "SIGKILL" || result.signal === 9)
	);
}

async function repoIdentity(cwd: string, checkout: string) {
	const remote = await run(
		["git", "config", "--get", "remote.origin.url"],
		cwd,
	);
	const origin = remote.stdout.trim();
	if (!origin) return checkout;
	if (isAbsolute(origin)) return resolve(origin);
	const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(origin);
	const url = URL.parse(
		scp ? `ssh://${scp[1]}/${scp[2]?.replace(/^\//, "")}` : origin,
	);
	if (!url) return resolve(checkout, origin);
	if (url.protocol === "file:")
		return resolve(decodeURIComponent(url.pathname));
	const path = url.pathname
		.replace(/\/+$/, "")
		.replace(/\.git$/, "")
		.slice(1);
	const hostname = url.hostname.toLowerCase();
	const host =
		url.protocol === "ssh:" && url.port === "22"
			? hostname
			: url.host.toLowerCase();
	return hostname === "github.com"
		? `${host}/${path.toLowerCase()}`
		: `${host}/${path}`;
}

export async function runAdmitted(request: Request): Promise<RunResult> {
	const { argv, cwd, config, options, measure } = request;
	if (!supportsAdmission && measure)
		throw new Error("Run cagr measure on macOS or Linux.");
	const env = { ...process.env, ...options.env };
	const marker = env[reservationEnv];
	const inherited =
		supportsAdmission &&
		marker !== undefined &&
		new Pool().hasReservation(marker);
	if (inherited && measure)
		throw new Error(
			"Run cagr measure outside an existing admission reservation.",
		);
	if (inherited || !supportsAdmission || (!measure && !config.enabled)) {
		const limit = runLimit(options);
		if (limit <= 0) return unsettled("deferred", deferred);
		return (options.execute ?? run)(argv, cwd, {
			...options,
			// The outer watchdog covers this group and holds the tokens until it exits.
			...(inherited ? { processGroup: false, closePipesAfterExit: true } : {}),
			timeoutMs: Number.isFinite(limit) ? limit : undefined,
		});
	}
	const classification = classifyArgv(argv, config, cwd);
	const light = classification.kind === "light";
	const pressure = options.pressure ?? pressureReader(config);
	if (!measure && light) {
		const first = await execute(request, pressure, 0, false, []);
		if (!loadTainted(first.result, first.elevated)) return first.result;
		options.log?.(
			"load-tainted: retrying the light command once after a timeout or SIGKILL under elevated memory pressure.",
		);
		const second = await execute(request, pressure, 0, false, []);
		if (second.result.admission)
			return { ...first.result, admission: "load-tainted", output: tainted };
		if (loadTainted(second.result, second.elevated))
			return { ...second.result, admission: "load-tainted", output: tainted };
		return second.result;
	}
	const pool = new Pool();
	const git = await gitContext(cwd);
	const repo = git.mainCheckout ?? git.toplevel ?? cwd;
	const identity = await repoIdentity(cwd, repo);
	const keys = {
		current: JSON.stringify([identity, classification.pattern]),
		legacy: JSON.stringify([repo, classification.pattern]),
	};
	const command = argv.map(shellQuote).join(" ");
	let retry: RunResult | undefined;
	for (let attempt = 0; attempt < (measure ? 1 : 2); attempt++) {
		const ticket: Ticket = {
			id: crypto.randomUUID(),
			order: 0,
			since: 0,
			pid: process.pid,
			repo,
			branch: git.branch ?? "(detached or no branch)",
			priority: priority(options),
			command,
			slots: [],
		};
		let release: (() => void) | undefined;
		try {
			const admitted = light
				? undefined
				: await admit(pool, ticket, request, keys, pressure);
			if (!light && !admitted)
				return (
					retry ??
					(options.deadline !== undefined && options.priority !== "push"
						? unsettled("deferred", deferred)
						: unsettled(
								"load-tainted",
								"load-tainted: memory admission wait expired. Retry when the machine is quieter.",
							))
				);
			if (typeof admitted === "string") return unsettled("deferred", admitted);
			release = admitted?.release;
			if (admitted)
				options.log?.(
					`load: admitted ${ticket.command} with ${admitted.tokens} token(s)`,
				);
			const dockerBytes = measure ? dockerMemory() : 0;
			const poolTokens = measure
				? Math.max(
						1,
						Math.floor(
							usableMemory(admitted?.current ?? pressure(), dockerBytes) / gib,
						),
					)
				: 0;
			const { result, elevated, peak } = await execute(
				request,
				pressure,
				admitted?.tokens ?? 0,
				classification.kind === "heavy",
				admitted?.locks ?? [],
				admitted ? `${ticket.id}:${admitted.tokens}` : undefined,
			);
			if (measure && result.ok) {
				if (!peak?.bytes)
					throw new Error(
						"The command exited before memory could be sampled. Measure a longer representative run.",
					);
				await pool.transaction(Infinity, () =>
					pool.record(
						{ totalBytes: totalmem(), poolTokens, dockerBytes },
						keys.current,
						peak.bytes,
					),
				);
				options.log?.(
					`load: measured ${peak.bytes} bytes (${peak.source}), pool ${poolTokens} token(s)`,
				);
			}
			if (result.admission) return retry ?? result;
			if (!loadTainted(result, elevated)) return result;
			retry = { ...result, admission: "load-tainted", output: tainted };
			if (!measure && attempt === 0)
				options.log?.(
					"load-tainted: re-queuing once after a timeout or SIGKILL under elevated memory pressure.",
				);
		} finally {
			release?.();
		}
	}
	return retry ?? unsettled("deferred", deferred);
}

export function runAdmittedShell(
	command: string,
	cwd: string,
	config: Config["admission"],
	options: AdmissionOptions = {},
) {
	return runAdmitted({
		argv: shellArgv(command),
		cwd,
		config,
		options,
		measure: false,
	});
}
