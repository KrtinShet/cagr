import { totalmem } from "node:os";
import type { Config } from "../config/schema";
import { gitContext } from "../git";
import {
	type RunOptions,
	type RunResult,
	run,
	shellArgv,
	shellQuote,
} from "../run";
import { classifyArgv } from "./classify";
import {
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
	usableMemory,
} from "./pressure";
import { canScope, memorySampler } from "./sample";

export type AdmissionOptions = RunOptions & {
	priority?: "push";
	execute?: typeof run;
	deadline?: number;
	log?: (line: string) => void;
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

function unsettled(
	admission: NonNullable<RunResult["admission"]>,
	output: string,
): RunResult {
	return { admission, ok: false, output, stdout: "", ms: 0, timedOut: false };
}

// A pipe closes on SIGKILL as well as on a normal exit. A surviving command group
// must stop when the owner of its memory tokens disappears.
function watchOwner(pid: number, locks: number[]) {
	const child = Bun.spawn(
		[
			"/bin/sh",
			"-c",
			'IFS= read -r done || /bin/kill -KILL -- "-$1" 2>/dev/null',
			"cagr-watch",
			String(pid),
		],
		{ stdio: ["pipe", "ignore", "ignore", ...locks], detached: true },
	);
	return async () => {
		child.stdin.write("done\n");
		await child.stdin.end();
		await child.exited;
	};
}

async function execute(
	request: Request,
	pressure: () => Pressure,
	tokens: number,
	heavy: boolean,
	locks: number[],
) {
	const { argv, cwd, options, measure } = request;
	const scope = (heavy || measure) && (await canScope(cwd));
	const unit = scope ? `cagr-${crypto.randomUUID()}.scope` : undefined;
	const command = unit
		? [
				"systemd-run",
				"--user",
				"--scope",
				"--quiet",
				`--unit=${unit}`,
				...(heavy && !measure ? ["-p", `MemoryMax=${tokens}G`] : []),
				"--",
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
	try {
		const result = await (options.execute ?? run)(command, cwd, {
			...options,
			timeoutMs: Number.isFinite(limit)
				? Math.max(1, Math.floor(limit))
				: undefined,
			processGroup: true,
			onSpawn: (pid) => {
				if (locks.length || options.inherit) stopWatch = watchOwner(pid, locks);
				if (measure) sample = memorySampler(pid, unit);
			},
		});
		samplePressure();
		if (samplingError)
			options.log?.(`cagr: memory monitoring error. ${samplingError}`);
		return { result, elevated, peak: sample?.() };
	} finally {
		clearInterval(timer);
		await stopWatch?.();
	}
}

async function admit(
	pool: Pool,
	ticket: Ticket,
	request: Request,
	key: string,
	pressure: () => Pressure,
) {
	const { config, measure, options } = request;
	const deadline = options.deadline ?? Infinity;
	let last = "";
	while (performance.now() < deadline) {
		const snapshot = await pool.transaction(deadline, () => {
			const entries = pool.list();
			if (ticket.order === 0) {
				ticket.order = Math.max(0, ...entries.map((entry) => entry.order)) + 1;
				ticket.since = Date.now();
				pool.save(ticket);
				entries.push(ticket);
				entries.sort(ticketOrder);
			}
			const queue = entries.filter((entry) => entry.slots.length === 0);
			const index = queue.findIndex((entry) => entry.id === ticket.id);
			const costs = pool.costs();
			const size = poolSize(config, costs);
			const peak = measure ? undefined : costs?.peaks[key];
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
		if ("release" in snapshot) {
			options.log?.(
				`load: admitted ${ticket.command} with ${snapshot.tokens} token(s)`,
			);
			return snapshot;
		}
		if (snapshot.message && last !== snapshot.message) {
			last = snapshot.message;
			options.log?.(last);
		}
		await Bun.sleep(
			Math.min(pollMs, Math.max(0, deadline - performance.now())),
		);
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

export async function runAdmitted(request: Request): Promise<RunResult> {
	const { argv, cwd, config, options, measure } = request;
	const classification = classifyArgv(argv, config);
	const light = classification.kind === "light";
	if (!measure && !config.enabled) {
		const limit = runLimit(options);
		if (limit <= 0) return unsettled("deferred", deferred);
		return (options.execute ?? run)(argv, cwd, {
			...options,
			timeoutMs: Number.isFinite(limit) ? limit : undefined,
		});
	}
	const pressure = options.pressure ?? pressureReader(config);
	if (!measure && light) {
		const first = await execute(request, pressure, 0, false, []);
		if (first.result.ok || !first.elevated || first.result.admission)
			return first.result;
		options.log?.(
			"load-tainted: retrying the light command once after a failure under elevated memory pressure.",
		);
		const second = await execute(request, pressure, 0, false, []);
		return !second.result.ok && (second.elevated || second.result.admission)
			? { ...second.result, admission: "load-tainted", output: tainted }
			: second.result;
	}
	const pool = new Pool();
	const git = await gitContext(cwd);
	const repo = git.mainCheckout ?? git.toplevel ?? cwd;
	const key = JSON.stringify([repo, classification.pattern]);
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
				: await admit(pool, ticket, request, key, pressure);
			if (!light && !admitted) return retry ?? unsettled("deferred", deferred);
			if (typeof admitted === "string") return unsettled("deferred", admitted);
			release = admitted?.release;
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
			);
			if (measure && result.ok) {
				if (!peak?.bytes)
					throw new Error(
						"The command exited before memory could be sampled. Measure a longer representative run.",
					);
				await pool.transaction(Infinity, () =>
					pool.record(
						{ totalBytes: totalmem(), poolTokens, dockerBytes },
						key,
						peak.bytes,
					),
				);
				options.log?.(
					`load: measured ${peak.bytes} bytes (${peak.source}), pool ${poolTokens} token(s)`,
				);
			}
			if (result.ok || !elevated || result.admission) return result;
			retry = { ...result, admission: "load-tainted", output: tainted };
			if (!measure && attempt === 0)
				options.log?.(
					"load-tainted: re-queuing once after a failure under elevated memory pressure.",
				);
		} finally {
			release?.();
			if (ticket.order) pool.remove(ticket);
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
