import { expect, test } from "bun:test";
import { run } from "./run";

test.skipIf(process.platform === "win32")(
	"a process-group timeout stops a child holding the output pipe open",
	async () => {
		const result = await run(["sh", "-c", "sleep 3 & exit 0"], process.cwd(), {
			processGroup: true,
			timeoutMs: 100,
		});
		expect(result.timedOut).toBe(true);
		expect(result.ms).toBeLessThan(2500);
		expect(result.ok).toBe(false);
	},
);
