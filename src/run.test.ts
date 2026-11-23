import { expect, spyOn, test } from "bun:test";
import { watch } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./run";

test.skipIf(process.platform === "win32")(
	"a timeout stops a child holding the output pipe open",
	async () => {
		const cwd = await mkdtemp(join(tmpdir(), "cagr-run-"));
		try {
			const result = await run(
				["sh", "-c", "(sleep 1; touch survived; sleep 2) & exit 0"],
				cwd,
				{ timeoutMs: 100 },
			);
			expect(result.timedOut).toBe(true);
			if (Bun.env.CAGR_TEST_LATENCY === "1")
				expect(result.ms).toBeLessThan(2500);
			expect(result.ok).toBe(false);
			await Bun.sleep(1100);
			expect(await Bun.file(join(cwd, "survived")).exists()).toBe(false);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	},
);

test.skipIf(process.platform === "win32")(
	"a timeout returns even if a child in another process group still holds a pipe",
	async () => {
		const cwd = await mkdtemp(join(tmpdir(), "cagr-run-"));
		const ready = Promise.withResolvers<number>();
		const watcher = watch(cwd, (_event, filename) => {
			if (filename) ready.resolve(Number(filename));
		});
		// Arm the timeout only after the detached child inherits the pipes.
		const schedule = setTimeout;
		let expire = () => {};
		const timer = spyOn(globalThis, "setTimeout").mockImplementationOnce(
			Object.assign(
				(...[callback]: Parameters<typeof setTimeout>) => {
					expire = callback;
					return schedule(callback, 4000);
				},
				{ __promisify__: schedule.__promisify__ },
			),
		);
		const pending = run(
			[
				process.execPath,
				"-e",
				`import { writeFileSync } from "node:fs";
				const child = Bun.spawn(["sleep", "10"], {
					detached: true, stdout: "inherit", stderr: "inherit"
				});
				child.unref();
				writeFileSync(String(child.pid), "");
				`,
			],
			cwd,
			{ timeoutMs: 350 },
		);
		timer.mockRestore();
		let pid = 0;
		try {
			pid = await Promise.race([ready.promise, pending.then(() => 0)]);
			expect(pid).toBeGreaterThan(0);
			expire();
			const result = await pending;
			expect(result.timedOut).toBe(true);
			if (Bun.env.CAGR_TEST_LATENCY === "1")
				expect(result.ms).toBeLessThan(2500);
		} finally {
			if (pid > 0) process.kill(pid, "SIGKILL");
			watcher.close();
			await rm(cwd, { recursive: true, force: true });
		}
	},
);
