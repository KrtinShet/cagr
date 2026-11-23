import { afterEach, expect, test } from "bun:test";
import {
	closeSync,
	mkdtempSync,
	readdirSync,
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

test("command.before denies unwrapped suites and preserves command guards within budget", async () => {
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
		reason: expect.stringContaining("Rerun as cagr run -- bun run verify"),
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
			"Rerun as cagr run -- sh -c 'bun run lint && bun run e2e'",
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

test("suite aliases and manager options retain their admission class", () => {
	const cwd = fixture();
	writeFileSync(
		join(cwd, "package.json"),
		JSON.stringify({
			scripts: {
				"check-all": "bun run verify",
				specs: "vitest run src/run.test.ts",
			},
		}),
	);
	const { admission } = resolveConfig({}, cwd, join(cwd, "cagr.toml"));
	const cases = [
		[["bun", "run", "--filter", "*", "verify"], "heavy"],
		[["bun", "run", "test", "src/run.test.ts"], "medium"],
		[["pnpm", "-r", "--filter=@app/web", "check-all", "--", "--fast"], "heavy"],
		[["npm", "--workspace", "app", "run", "specs"], "medium"],
		[["yarn", "run", "verify", "--reporter", "dot"], "heavy"],
		[["pnpm", "-w", "run", "verify"], "heavy"],
		[["yarn", "workspace", "app", "run", "verify"], "heavy"],
		[["bun", "test", "src/run.test.ts"], "light"],
		[["vitest", "run", "src/run.test.ts"], "light"],
		[["vitest", "run"], "medium"],
	] as const;
	for (const [argv, kind] of cases)
		expect(classifyArgv([...argv], admission, cwd).kind, argv.join(" ")).toBe(
			kind,
		);
});

test("shell comments are ignored without hiding real commands", () => {
	const cwd = fixture();
	const { admission } = resolveConfig({}, cwd, join(cwd, "cagr.toml"));
	const kind = (line: string) =>
		classifyArgv(["sh", "-c", line], admission).kind;
	expect(kind("printf ok # note; bun run verify")).toBe("light");
	expect(kind("printf %s '#'; bun run verify")).toBe("heavy");
	expect(kind("printf ok # note <<EOF\nbun run verify")).toBe("heavy");
});

test("oversized command lists are classified as heavy within the hook budget", () => {
	const cwd = fixture();
	const { admission } = resolveConfig({}, cwd, join(cwd, "cagr.toml"));
	const kind = (line: string) =>
		classifyArgv(["sh", "-c", line], admission).kind;
	const start = performance.now();
	expect(kind("printf ok\n".repeat(1_000))).toBe("heavy");
	expect(kind(`bun run verify\n${"printf ok\n".repeat(1_000)}`)).toBe("heavy");
	expect(performance.now() - start).toBeLessThan(50);
});

test("ordinary exit codes survive pressure without repeating side effects", async () => {
	const proc = spawn(
		fixture(),
		runner(`
		const result = await runAdmitted({
			argv: ["sh", "-c", "echo side-effect >&2; exit 42"], cwd, config, measure: false,
			options: {
				inherit: true, log: console.error,
				pressure: () => ({ elevated: true, description: "injected pressure" }),
			},
		});
		process.exit(result.exitCode ?? 1);
	`),
	);
	const { code, output } = await proc.finished();
	expect(code).toBe(42);
	expect(output.trim()).toBe("side-effect");
});

test("nested commands inherit a real reservation from the outer wrapper", async () => {
	const cwd = fixture();
	writeFileSync(
		join(cwd, "cagr.toml"),
		'[admission]\npool_tokens = 1\nheavy = ["sleep"]\n',
	);
	const proc = spawn(
		cwd,
		runner(`
		const nested = [process.execPath, ${JSON.stringify(cliPath)}, "run", "--", "sh", "-c", "sleep 0; exit 42"];
		const line = 'sleep 0; "$@"';
		const result = await runAdmitted({
			argv: ["sh", "-c", line, "sh", ...nested], cwd, config, measure: false,
			options: {
				log: console.error, timeoutMs: 1500,
				pressure: () => ({ elevated: false, description: "normal" }),
			},
		});
		console.error(result.output);
		process.exit(result.exitCode ?? 1);
	`),
	);
	const { code, output } = await proc.finished();
	expect(output).toContain("with 1 token(s)");
	expect(code).toBe(42);
});

test("a push waiting past its admission deadline asks for a retry", async () => {
	const proc = spawn(
		fixture(),
		runner(`
		const result = await runAdmitted({
			argv: ["sleep", "1"], cwd, config, measure: false,
			options: {
				priority: "push", deadline: performance.now() + 100,
				pressure: () => ({ elevated: true, description: "injected pressure" }),
			},
		});
		console.error(result.admission, result.output);
	`),
	);
	const { output } = await proc.finished();
	expect(output).toContain("load-tainted");
	expect(output).toMatch(/[Rr]etry|[Rr]erun/);
});

test("tokens stay held while the shell's background child is still running", async () => {
	const cwd = fixture();
	const holder = queued(cwd, ["sh", "-c", "sleep 1 </dev/null & exit 0"]);
	await holder.seen("load: admitted");
	const waiter = queued(cwd, ["sleep", "0.01"]);
	await waiter.seen(`tokens held by pid ${holder.child.pid}`);
	expect((await holder.finished()).code).toBe(0);
	expect((await waiter.finished()).code).toBe(0);
});

test("watchdog startup failure kills the command and pre-push allows with a notice", async () => {
	const proc = spawn(
		fixture(),
		runner(`
		import { prePush } from ${JSON.stringify(resolve(import.meta.dir, "../git-hooks.ts"))};
		import { resolveConfig } from ${JSON.stringify(resolve(import.meta.dir, "../config/load.ts"))};
		const spawn = Bun.spawn;
		let pid;
		Bun.spawn = (argv, options) => {
			if (argv.includes("cagr-watch")) throw new Error("EMFILE: watchdog failed");
			const child = spawn(argv, options);
			if (argv.includes("sleep 30")) pid = child.pid;
			return child;
		};
		const originalPressure = { linux_some_avg10: 100, linux_full_avg10: 100, mac_pressure_level: 8 };
		const hookConfig = resolveConfig({
			admission: { ...originalPressure, medium: ["sleep"], pool_tokens: 1 },
			git: { pre_push: ["sleep 30"] },
		}, cwd, "cagr.toml");
		const result = await prePush("", hookConfig, cwd);
		console.error(JSON.stringify(result));
		if (!pid) process.exit(2);
		try {
			process.kill(pid, 0);
			process.kill(-pid, "SIGKILL");
			process.exit(3);
		} catch (error) {
			if (error.code !== "ESRCH") throw error;
		}
	`),
	);
	const { code, output } = await proc.finished();
	expect(output).toContain('"ok":true');
	expect(output).toContain("EMFILE: watchdog failed");
	expect(code).toBe(0);
});

test("an actual SIGKILL under pressure requeues but an explicit exit 137 does not", async () => {
	const proc = spawn(
		fixture(),
		runner(`
		const result = await runAdmitted({
			argv: ["sh", "-c", "if test -f ran; then echo second >&2; exit 137; fi; touch ran; kill -KILL $$"],
			cwd, config, measure: false,
			options: {
				inherit: true, log: console.error,
				pressure: () => ({ elevated: true, description: "injected pressure" }),
			},
		});
		console.error(JSON.stringify({ code: result.exitCode, admission: result.admission }));
	`),
	);
	const { output } = await proc.finished();
	expect(output.match(/retrying/g)).toHaveLength(1);
	expect(output).toContain("second");
	expect(output).toContain('{"code":137}');
});

test("measurement in an ordinary clone is reused in local CI's bare-origin worktree", async () => {
	const proc = spawn(
		fixture(),
		runner(`
		function git(...args) {
			const result = Bun.spawnSync(["git", ...args]);
			if (!result.success) throw new Error(result.stderr.toString());
		}
		git("init", "-q", "checkout");
		git("-C", "checkout", "remote", "add", "origin", "git@GitHub.COM:Example/Project.git");
		git("-C", "checkout", "-c", "user.name=cagr", "-c", "user.email=cagr@example.com",
			"commit", "-qm", "chore: init", "--allow-empty");
		git("clone", "--bare", "-q", "checkout", "scratch");
		git("--git-dir=scratch", "remote", "set-url", "origin", "https://github.com/example/project.git");
		git("--git-dir=scratch", "worktree", "add", "--detach", "-q", "ci", "HEAD");
		const argv = ["sleep", "0.4"];
		const options = {
			log: console.error,
			pressure: () => ({ elevated: false, available: 8 * 1024 ** 3, description: "normal" }),
		};
		const config2 = { ...config, pool_tokens: 2 };
		const measured = await runAdmitted({ argv, cwd: cwd + "/checkout", config: config2, measure: true, options });
		if (!measured.ok) throw new Error(measured.output);
		console.error("scratch run:");
		const result = await runAdmitted({ argv, cwd: cwd + "/ci", config: config2, measure: false, options });
		process.exit(result.exitCode ?? 1);
	`),
	);
	const { code, output } = await proc.finished();
	expect(code).toBe(0);
	expect(output).toContain(
		"scratch run:\nload: admitted sleep 0.4 with 1 token(s)",
	);
});

test.skipIf(process.platform !== "linux")(
	"systemd 254 keeps scope arguments literal and 253 skips the scope",
	async () => {
		const cwd = fixture();
		writeFileSync(
			join(cwd, "systemd-run"),
			`#!/bin/sh
if [ "$1" = "--version" ]; then
	printf 'systemd %s\\n' "$SCOPE_VERSION"
	exit 0
fi
printf 'scope %s\\n' "$*" >> scope.log
while [ "$1" != "--" ]; do shift; done
shift
exec "$@"
`,
			{ mode: 0o700 },
		);
		for (const version of [253, 254]) {
			const proc = spawn(
				cwd,
				runner(`
			process.env.SCOPE_VERSION = "${version}";
			process.env.PATH = cwd + ":" + process.env.PATH;
			config.heavy = ["printf"];
			const result = await runAdmitted({
				argv: ["printf", "%s", "$HOME"], cwd, config, measure: false,
				options: { log: console.error, pressure: () => ({ elevated: false, description: "normal" }) },
			});
			console.error(result.stdout);
			process.exit(result.exitCode ?? 1);
		`),
			);
			const { code, output } = await proc.finished();
			expect(code).toBe(0);
			expect(output.trimEnd()).toEndWith("$HOME");
			if (version === 253) {
				expect(output).toContain("running without a systemd scope");
				expect(await Bun.file(join(cwd, "scope.log")).exists()).toBe(false);
			} else {
				const scope = readFileSync(join(cwd, "scope.log"), "utf8");
				expect(scope).toMatch(
					/--expand-environment=no[^\n]* cagr-scope printf %s \$HOME/,
				);
			}
		}
	},
);

test("Windows allows Bash without rewriting and runs explicit wrappers directly", async () => {
	const cwd = fixture();
	writeFileSync(join(cwd, "cagr.toml"), '[admission]\nheavy = ["bun"]\n');
	const proc = spawn(cwd, [
		"-e",
		`
		Object.defineProperty(process, "platform", { value: "win32" });
		const { tryLock } = await import(${JSON.stringify(resolve(import.meta.dir, "locks.ts"))});
		const { runHook } = await import(${JSON.stringify(resolve(import.meta.dir, "../hook/run-hook.ts"))});
		const { runCli } = await import(${JSON.stringify(cliPath)});
		try {
			tryLock("guard.lock");
		} catch (error) {
			console.error(error.message);
		}
		const output = await runHook("codex", "command.before", JSON.stringify({
			cwd: process.cwd(), tool_input: { command: "bun run verify" }
		}), process.cwd());
		console.error("hook " + JSON.stringify(output));
		runCli(["run", "--", process.execPath, "-e", "console.error('command ran'); process.exit(42)"]);
	`,
	]);
	const { code, output } = await proc.finished();
	expect(output).toContain(
		"Memory admission locks are available on macOS and Linux",
	);
	expect(await Bun.file(join(cwd, "guard.lock")).exists()).toBe(false);
	expect(output).toContain('hook ""');
	expect(output).toContain("command ran");
	expect(code).toBe(42);
});

test("the explicit wrapper fails open before spawn if the pool is inaccessible", async () => {
	const cwd = fixture();
	writeFileSync(join(cwd, ".cache"), "");
	writeFileSync(join(cwd, "cagr.toml"), '[admission]\nheavy = ["echo"]\n');
	const proc = spawn(cwd, [
		cliPath,
		"run",
		"--",
		"sh",
		"-c",
		"echo command-ran >&2; exit 42",
	]);
	const { code, output } = await proc.finished();
	expect(output).toContain("Running without admission");
	expect(output.match(/^command-ran$/gm)).toHaveLength(1);
	expect(code).toBe(42);
});

test("the explicit wrapper does not repeat a started command after watchdog failure", async () => {
	const proc = spawn(fixture(), [
		"-e",
		`
		const { runCli } = await import(${JSON.stringify(cliPath)});
		const spawn = Bun.spawn;
		let attempts = 0;
		Bun.spawn = (argv, options) => {
			if (argv.includes("cagr-watch")) throw new Error("EMFILE: watchdog failed");
			if (argv.includes("sleep 30")) console.error("command starts", ++attempts);
			return spawn(argv, options);
		};
		runCli(["run", "--", "sh", "-c", "sleep 30"]);
	`,
	]);
	const { code, output } = await proc.finished();
	expect(output).toContain("EMFILE: watchdog failed");
	expect(output.match(/^command starts /gm)).toHaveLength(1);
	expect(output).not.toContain("Running without admission");
	expect(code).toBe(2);
});

test("an unrelated session cannot borrow a live reservation", async () => {
	const cwd = fixture();
	const holder = queued(cwd, ["sh", "-c", "read signal"]);
	await holder.seen("load: admitted");
	const tickets = join(cwd, ".cache/cagr/slots/tickets");
	const [name] = readdirSync(tickets);
	if (!name) throw new Error("Missing admission ticket");
	const marker = `${name.replace(/\.json$/, "")}:1`;
	const borrower = spawn(
		cwd,
		runner(`
		const result = await runAdmitted({
			argv: ["sleep", "0.01"], cwd, config, measure: false,
			options: {
				env: { CAGR_ADMISSION_HELD: ${JSON.stringify(marker)} },
				deadline: performance.now() + 500,
				pressure: () => ({ elevated: false, description: "normal" }),
				log: console.error,
			},
		});
		console.error(result.admission ?? result.exitCode);
	`),
	);
	const { output } = await borrower.finished();
	expect(output).toContain(`tokens held by pid ${holder.child.pid}`);
	expect(output.trimEnd()).toEndWith("deferred");
	holder.child.stdin.write("release\n");
	expect((await holder.finished()).code).toBe(0);
});

test("tokens stay held after SIGKILL while the process group still exists", async () => {
	const proc = spawn(
		fixture(),
		runner(`
		const kill = process.kill;
		let killedAt;
		let group;
		process.kill = (target, signal) => {
			if (target < 0 && signal === "SIGKILL") {
				killedAt = performance.now();
				group = target;
			}
			if (target === group && signal === 0 && performance.now() - killedAt < 750)
				return true;
			return kill(target, signal);
		};
		const result = await runAdmitted({
			argv: ["sleep", "30"], cwd, config, measure: false,
			options: {
				timeoutMs: 500,
				log: console.error,
				pressure: () => ({ elevated: false, description: "normal" }),
			},
		});
		console.error(JSON.stringify({ timedOut: result.timedOut, drained: performance.now() - killedAt >= 750 }));
	`),
	);
	const { output } = await proc.finished();
	expect(output).toContain("Holding its admission tokens while it drains");
	expect(output).toContain('{"timedOut":true,"drained":true}');
});

test("inherited pre-push finishes when a background process keeps its pipes open", async () => {
	const proc = spawn(
		fixture(),
		runner(`
		const script = ${JSON.stringify(`
			import { prePush } from ${JSON.stringify(resolve(import.meta.dir, "../git-hooks.ts"))};
			import { resolveConfig } from ${JSON.stringify(resolve(import.meta.dir, "../config/load.ts"))};
			const cwd = process.cwd();
			const config = resolveConfig({
				git: { pre_push: ["sleep 3600 & echo check-finished; exit 0"] },
			}, cwd, "cagr.toml");
			const result = await prePush("", config, cwd);
			console.log(JSON.stringify(result));
			process.exit(result.ok ? 0 : 1);
		`)};
		const result = await runAdmitted({
			argv: ["sh", "-c", 'sleep 0; exec "$@"', "sh", process.execPath, "-e", script],
			cwd, config, measure: false,
			options: {
				timeoutMs: 3250, log: console.error,
				pressure: () => ({ elevated: false, description: "normal" }),
			},
		});
		console.error(result.stdout);
		process.exit(result.exitCode ?? 1);
	`),
	);
	const { code, output } = await proc.finished();
	expect(output).toContain('"ok":true');
	expect(code).toBe(0);
});

test("cagr run preserves 126, 127 and signal exit codes", async () => {
	const cwd = fixture();
	writeFileSync(join(cwd, "not-executable"), "echo should-not-run\n", {
		mode: 0o600,
	});
	for (const [argv, expected] of [
		[["./not-executable"], 126],
		[["./missing"], 127],
		[["sh", "-c", "kill -TERM $$"], 143],
	] as const) {
		const proc = spawn(cwd, [cliPath, "run", "--", ...argv]);
		const { code, output } = await proc.finished();
		expect(code, argv.join(" ")).toBe(expected);
		if (expected !== 143) expect(output).toContain("Could not start");
	}
});

test("a group still alive at the cleanup deadline produces an explicit release warning", async () => {
	const proc = spawn(
		fixture(),
		runner(`
		const kill = process.kill;
		const now = performance.now.bind(performance);
		let group;
		let elapsed = 0;
		process.kill = (target, signal) => {
			if (target < 0 && signal === "SIGKILL") {
				group = target;
				performance.now = () => now() + (elapsed += 30_000);
			}
			if (target === group && signal === 0) return true;
			return kill(target, signal);
		};
		await runAdmitted({
			argv: ["sleep", "30"], cwd, config, measure: false,
			options: {
				timeoutMs: 180,
				log: console.error,
				pressure: () => ({ elevated: false, description: "normal" }),
			},
		});
	`),
	);
	const { output } = await proc.finished();
	expect(output).toContain("WARNING:");
	expect(output).toContain("Releasing its admission tokens");
});
