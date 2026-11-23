import { afterEach, expect, test } from "bun:test";
import {
	closeSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveConfig } from "../config/load";
import { handle } from "../hook/handlers";
import { classifyArgv } from "./classify";
import { tryLock } from "./locks";
import { type Costs, Pool } from "./pool";
import { gib, parseLinuxMemory } from "./pressure";

const modulePath = resolve(import.meta.dir, "run.ts");
const cliPath = resolve(import.meta.dir, "../cli.ts");
const directories: string[] = [];
const processes: Bun.Subprocess<"pipe", "ignore", "pipe">[] = [];

afterEach(async () => {
	for (const child of processes.splice(0)) {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
	}
	for (const folder of directories.splice(0))
		rmSync(folder, { recursive: true, force: true });
});

function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "cagr-admission-"));
	directories.push(cwd);
	return cwd;
}

function spawn(cwd: string, args: string[], priority = "") {
	const child = Bun.spawn([process.execPath, ...args], {
		cwd,
		env: { ...process.env, HOME: cwd, CAGR_PRIORITY: priority },
		stdin: "pipe",
		stdout: "ignore",
		stderr: "pipe",
	});
	processes.push(child);
	let output = "";
	const finished = (async () => {
		const reader = child.stderr.getReader();
		const decoder = new TextDecoder();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			output += decoder.decode(value, { stream: true });
		}
		output += decoder.decode();
	})();
	return {
		child,
		async seen(needle: string) {
			const deadline = performance.now() + 8000;
			while (
				!output.includes(needle) &&
				child.exitCode === null &&
				performance.now() < deadline
			)
				await Bun.sleep(20);
			if (child.exitCode !== null) await finished;
			expect(output).toContain(needle);
			return output;
		},
		async finished() {
			const code = await child.exited;
			await finished;
			return { code, output };
		},
	};
}

const runner = (body: string) => [
	"-e",
	`
	import { runAdmitted } from ${JSON.stringify(modulePath)};
	const cwd = process.cwd();
	const config = {
		enabled: true, heavy: ["read", "sleep"], light: [], medium: [], pool_tokens: 1,
		linux_some_avg10: 10, linux_full_avg10: 1, mac_pressure_level: 2, mac_swap_growth_mib: 0,
	};
	${body}
`,
];

function queued(cwd: string, argv: string[], priority?: string) {
	return spawn(
		cwd,
		runner(`
		const result = await runAdmitted({
			argv: ${JSON.stringify(argv)}, cwd, config, measure: false,
			options: {
				inherit: true, log: console.error,
				pressure: () => ({ elevated: false, description: "normal" }),
			},
		});
		process.exit(result.exitCode ?? 1);
	`),
		priority,
	);
}

test("a returned lock descriptor keeps another process out", async () => {
	const cwd = fixture();
	const lock = tryLock(join(cwd, "token.lock"));
	if (lock === null) throw new Error("Test lock was already held");
	const probe = () =>
		spawn(cwd, [
			"-e",
			`
		import { tryLock } from ${JSON.stringify(resolve(import.meta.dir, "locks.ts"))};
		process.exit(tryLock("token.lock") === null ? 75 : 0);
	`,
		]).finished();
	try {
		expect((await probe()).code).toBe(75);
	} finally {
		closeSync(lock);
	}
	expect((await probe()).code).toBe(0);
});

test("a stale ticket cannot survive PID reuse", async () => {
	const cwd = fixture();
	const pool = new Pool(cwd);
	pool.save({
		id: "stale",
		pid: process.pid,
		repo: cwd,
		branch: "feat/prior",
		command: "sleep 30",
		since: Date.now(),
		order: 1,
		priority: "normal",
		slots: [0],
	});
	expect(await pool.transaction(Infinity, () => pool.list())).toEqual([]);
});

test("a heavy waiter acquires the held token after normal exit", async () => {
	const cwd = fixture();
	const holder = queued(cwd, ["sh", "-c", "read signal"]);
	await holder.seen("load: admitted");
	const waiter = queued(cwd, ["sleep", "0.01"]);
	await waiter.seen(`tokens held by pid ${holder.child.pid}`);
	holder.child.stdin.write("release\n");
	expect((await holder.finished()).code).toBe(0);
	await waiter.seen("load: admitted");
	expect((await waiter.finished()).code).toBe(0);
});

test("SIGKILL releases a holder's tokens and the next waiter runs", async () => {
	const cwd = fixture();
	const holder = queued(cwd, ["sh", "-c", "read signal"]);
	await holder.seen("load: admitted");
	const waiter = queued(cwd, ["sleep", "0.01"]);
	await waiter.seen(`tokens held by pid ${holder.child.pid}`);
	holder.child.kill("SIGKILL");
	await holder.finished();
	await waiter.seen("load: admitted");
	expect((await waiter.finished()).code).toBe(0);
});

test("push and lease waiters go ahead of earlier lower-priority waiters", async () => {
	const cwd = fixture();
	const holder = queued(cwd, ["sh", "-c", "read signal"]);
	await holder.seen("load: admitted");
	const normal = queued(cwd, ["sleep", "0.01"]);
	await normal.seen(`tokens held by pid ${holder.child.pid}`);
	const push = queued(cwd, ["sh", "-c", "read signal"], "push");
	await normal.seen(`behind pid ${push.child.pid}`);
	const lease = queued(cwd, ["sh", "-c", "read signal"], "lease");
	await push.seen(`behind pid ${lease.child.pid}`);
	holder.child.stdin.write("release\n");
	await lease.seen("load: admitted");
	await push.seen(`tokens held by pid ${lease.child.pid}`);
	lease.child.stdin.write("release\n");
	await push.seen("load: admitted");
	await normal.seen(`tokens held by pid ${push.child.pid}`);
	push.child.stdin.write("release\n");
	expect((await normal.finished()).code).toBe(0);
});

test("pressure holds admission and a pressure-tainted timeout retries once", async () => {
	const proc = spawn(
		fixture(),
		runner(`
		let elevated = true;
		let attempts = 0;
		const result = await runAdmitted({
			argv: ["sleep", "3"], cwd, config, measure: false,
			options: {
				pressure: () => ({ elevated, description: "injected pressure" }),
				timeoutMs: 200,
				log: (line) => {
					console.error(line);
					if (line.includes("waiting for 1 GiB")) elevated = false;
					if (line.includes("admitted")) {
						elevated = true;
						attempts++;
					}
					if (line.includes("re-queuing")) elevated = false;
				},
			},
		});
		console.error(JSON.stringify({ attempts, timedOut: result.timedOut, outcome: result.admission }));
		console.error(result.output);
	`),
	);
	const { code, output } = await proc.finished();
	expect(code).toBe(0);
	expect(output).toContain("queue #1, waiting for 1 GiB and normal pressure");
	expect(output).toContain("re-queuing once");
	expect(output).toContain(
		'{"attempts":2,"timedOut":true,"outcome":"load-tainted"}',
	);
	expect(output).toContain("Rerun when the machine is quieter");
});

test("queue admission respects the turn-end deadline", async () => {
	const proc = spawn(
		fixture(),
		runner(`
		const result = await runAdmitted({
			argv: ["sleep", "2"], cwd, config, measure: false,
			options: {
				deadline: performance.now() + 250,
				log: console.error,
				pressure: () => ({ elevated: true, description: "injected pressure" }),
			},
		});
		console.error(result.output);
	`),
	);
	const { output } = await proc.finished();
	expect(output).toContain("load: turn-end checks deferred");
	expect(output).not.toContain("load: admitted");
});

test("command.before denies direct heavy commands and allows light and wrapped calls within budget", async () => {
	const cwd = fixture();
	const config = resolveConfig(
		{
			commands: {
				blocked: [{ match: "git reset --hard", reason: "Keep changes." }],
			},
		},
		cwd,
		join(cwd, "cagr.toml"),
	);
	const before = (command: string) =>
		handle(
			{
				event: "command.before",
				cwd,
				sessionId: "admission-test",
				command,
				files: [],
			},
			config,
		);
	const start = performance.now();
	expect(await before("bun run verify")).toMatchObject({
		kind: "deny",
		reason: expect.stringContaining("cagr run -- bun run verify"),
	});
	expect(await before("bun test src/run.test.ts --timeout 500")).toEqual({
		kind: "allow",
	});
	expect(await before("cagr run -- bun run verify")).toEqual({ kind: "allow" });
	expect(performance.now() - start).toBeLessThan(50);
	expect(await before("cagr run -- sh -c 'git reset --hard'")).toMatchObject({
		kind: "deny",
		reason: expect.stringContaining("Keep changes."),
	});
	expect(await before("bun run lint && bun run e2e")).toMatchObject({
		kind: "deny",
		reason: expect.stringContaining(
			"cagr run -- sh -c 'bun run lint && bun run e2e'",
		),
	});
	expect(classifyArgv(["pnpm", "test"], config.admission).kind).toBe("medium");
});

test("cagr measure stores a sampled command tree peak and usable pool", async () => {
	const cwd = fixture();
	writeFileSync(join(cwd, "cagr.toml"), "[admission]\npool_tokens = 1\n");
	const alloc =
		"const bytes = Buffer.alloc(48 * 1024 ** 2, 7); setTimeout(() => console.log(bytes.at(-1)), 500)";
	const proc = spawn(cwd, [
		cliPath,
		"measure",
		"--",
		process.execPath,
		"-e",
		alloc,
	]);
	const { code, output } = await proc.finished();
	expect(output).toContain("load: measured ");
	expect(code).toBe(0);
	const machines = JSON.parse(
		readFileSync(join(cwd, ".cache/cagr/costs.json"), "utf8"),
	) as Record<string, Costs>;
	const machine = Object.values(machines)[0];
	expect(machine?.poolTokens).toBeGreaterThanOrEqual(1);
	expect(machine?.totalBytes).toBeGreaterThan(gib);
	expect(Object.values(machine?.peaks ?? {})[0]).toBeGreaterThanOrEqual(
		48 * 1024 ** 2,
	);
});

test("reads Linux PSI avg10 and converts MemAvailable to bytes", () => {
	expect(
		parseLinuxMemory(
			"some avg10=10.31 avg60=4.47 avg300=2.55 total=87209028\nfull avg10=1.03 avg60=0.40 avg300=0.14 total=222\n",
			"MemTotal:      16381184 kB\nMemFree:       3078900 kB\nMemAvailable:  8211104 kB\n",
		),
	).toEqual({ some: 10.31, full: 1.03, available: 8_211_104 * 1024 });
	expect(() => parseLinuxMemory("some avg10=0.00", "")).toThrow("MemAvailable");
});
