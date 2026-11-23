import { expect, test } from "bun:test";
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
		const result = await run(
			[
				process.execPath,
				"-e",
				'const child = Bun.spawn(["sleep", "3"], { detached: true, stdout: "inherit", stderr: "inherit" }); child.unref(); console.log(child.pid);',
			],
			process.cwd(),
			{ timeoutMs: 350 },
		);
		const pid = Number(result.stdout.trim());
		try {
			expect(pid).toBeGreaterThan(0);
			expect(result.timedOut).toBe(true);
			expect(result.ms).toBeLessThan(2500);
		} finally {
			if (pid > 0 && result.timedOut) process.kill(pid, "SIGKILL");
		}
	},
);
