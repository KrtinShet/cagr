import { expect, test } from "bun:test";
import { join } from "node:path";
import { repoTestTimeout } from "../test/budgets";
import { tempRepo } from "../test/repo";
import { finding, record, round } from "../test/review";
import { parseReviewArgs } from "./cli";
import { recordPath, writeRecord } from "./store";

test("--scan takes the globs up to the next option, wherever the options sit", () => {
	expect(parseReviewArgs(["--issue", "--scan", "src/**"])).toMatchObject({
		scan: ["src/**"],
		issue: true,
	});
	expect(
		parseReviewArgs(["--scan", "src/**", "lib/**", "--effort", "deep"]),
	).toMatchObject({ scan: ["src/**", "lib/**"], effort: "deep" });
	expect(parseReviewArgs(["--base", "dev"])).toMatchObject({
		base: "dev",
		scan: undefined,
	});
});

test("--scan with no globs, or an unknown option, is an error", () => {
	expect(() => parseReviewArgs(["--scan", "--issue"])).toThrow(
		"Name the globs to scan",
	);
	expect(() => parseReviewArgs(["--fast"])).toThrow("Unknown option --fast");
});

test("--full is accepted and forces a full round", () => {
	expect(parseReviewArgs(["--full"])).toMatchObject({ full: true });
	expect(parseReviewArgs([])).toMatchObject({ full: false });
});

test(
	"review refuses a fourth round and an old ten-round record, listing only open Important findings",
	async () => {
		const repo = await tempRepo();
		await repo.git("checkout", "-q", "-b", "feat/x");
		const head = await repo.commit("feat: add x", {
			"src/a.ts": "export const x = 1;\n",
			"cagr.toml": "[review]\nenabled = true\n",
		});
		const base = await repo.git("rev-parse", "main");
		const file = recordPath(join(repo.root, ".git"), "feat/x");
		for (const scopes of [
			["full", "diff", "verify"],
			[
				"full",
				"diff",
				"diff",
				"diff",
				"diff",
				"diff",
				"diff",
				"diff",
				"full",
				"diff",
			],
		] as const) {
			writeRecord(
				file,
				record(
					scopes.map((scope, i) =>
						round({ n: i + 1, head, from: base, scope }),
					),
					[
						finding({ id: "f11" }),
						finding({ id: "f12" }),
						finding({ id: "f13", severity: "nit" }),
						finding({ id: "f14", status: "answered" }),
						finding({ id: "f15", status: "fixed", fixedIn: head }),
					],
				),
			);
			const result = Bun.spawnSync(
				[process.execPath, join(import.meta.dir, "../cli.ts"), "review"],
				{ cwd: repo.root, env: { ...process.env, PATH: "/usr/bin:/bin" } },
			);
			const output = result.stdout.toString() + result.stderr.toString();
			expect(result.exitCode).toBe(2);
			expect(output).toContain("Review is capped at 3 rounds for this branch.");
			expect(output).toContain(
				'cagr review answer <id> --wrong|--intentional|--minor "<why>"',
			);
			expect(output.match(/^- f\d+/gm)).toEqual(["- f11", "- f12"]);
		}
	},
	repoTestTimeout,
);
