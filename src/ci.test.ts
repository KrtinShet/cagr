import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectionBudget } from "./changes/check";
import { annotations, ci, ciReport, publish } from "./ci";
import { resolveConfig } from "./config/load";
import type { RawConfig } from "./config/presets";
import * as runner from "./run";
import { sync } from "./sync";
import { repoTestTimeout, roomyBudgets } from "./test/budgets";
import { tempRepo } from "./test/repo";

roomyBudgets(collectionBudget);

async function branch(
	raw: RawConfig,
	files: Record<string, string>,
	subject: string,
) {
	const repo = await tempRepo();
	const config = resolveConfig(
		{ admission: { enabled: false }, ...raw },
		repo.root,
		join(repo.root, "cagr.toml"),
	);
	sync(config);
	await repo.commit("chore: add cagr", {});
	await repo.git("checkout", "-q", "-b", "feat/x");
	await repo.commit(subject, files);
	return { repo, config };
}

const stack = (extra: Record<string, unknown>) => ({
	extends: ["recommended"],
	stack: [
		{
			language: "typescript",
			package_manager: "bun",
			paths: ["src/**"],
			...extra,
		},
	],
});

// Builds a Git branch and runs every committed CI check.
test(
	"a clean branch passes every check and reports its risk tier",
	async () => {
		const { repo, config } = await branch(
			stack({ on_turn_end: ["test -f {files}"] }),
			{ "src/a.ts": "export const a = 1;\n" },
			"feat: add a",
		);
		const result = await ci(config, { cwd: repo.root, base: "main", env: {} });
		expect(ciReport(result)).not.toContain("FAIL");
		expect(result.ok).toBe(true);
		expect(
			result.checks.some(({ name }) => name === "Pull request title"),
		).toBe(false);
		expect(result.checks.some(({ name }) => name === "Verify")).toBe(false);
		expect(result.tier).toBe("medium");
	},
	repoTestTimeout,
);

// Builds a clean Git branch before running CI for each Verify command.
test.each([
	{ command: "test -f src/a.ts", ok: true, verify: { ok: true, output: "" } },
	{
		command: "echo verify failed; exit 17",
		ok: false,
		verify: { ok: false, output: "echo verify failed; exit 17\nverify failed" },
	},
	{ command: " ", ok: true, verify: undefined },
])(
	"CI reports Verify for '$command'",
	async ({ command, ok, verify }) => {
		const { repo, config } = await branch(
			{ ...stack({}), git: { pre_push: command } },
			{ "src/a.ts": "export const a = 1;\n" },
			"feat: add a",
		);
		const result = await ci(config, { cwd: repo.root, base: "main", env: {} });
		expect(result.ok).toBe(ok);
		expect(result.checks.find((entry) => entry.name === "Verify")).toEqual(
			verify && { ...verify, name: "Verify", annotations: [] },
		);
	},
	repoTestTimeout,
);

// Builds a real Git branch before checking command reuse in CI.
test(
	"Verify reuses the result of an identical turn-end command",
	async () => {
		const shared = "test ! -f src/a.ts";
		const verify = "test -f src/a.ts";
		const { repo, config } = await branch(
			{
				...stack({ on_turn_end: ["test ! -f {files}"] }),
				git: { pre_push: [shared, verify] },
			},
			{ "src/a.ts": "export const a = 1;\n" },
			"feat: add a",
		);
		const runCheck = spyOn(runner, "runShell");
		try {
			const result = await ci(config, {
				cwd: repo.root,
				base: "main",
				env: {},
				runCheck,
			});
			expect(runCheck.mock.calls.map(([command]) => command)).toEqual([
				shared,
				verify,
			]);
			expect(
				result.checks.filter((entry) => !entry.ok).map((entry) => entry.name),
			).toEqual(["Checks", "Verify"]);
		} finally {
			runCheck.mockRestore();
		}
	},
	repoTestTimeout,
);

// Exercises the fallback by resolving the real Git base and merge base.
test(
	"an empty GITHUB_BASE_REF, as on merge_group, falls back to the protected branch",
	async () => {
		const { repo, config } = await branch(
			stack({}),
			{ "src/a.ts": "export const a = 1;\n" },
			"feat: add a",
		);
		const event = join(mkdtempSync(join(tmpdir(), "gw-ev-")), "event.json");
		writeFileSync(event, JSON.stringify({ merge_group: {} }));
		const result = await ci(config, {
			cwd: repo.root,
			env: { GITHUB_BASE_REF: "", GITHUB_EVENT_PATH: event },
		});
		expect(result.ok).toBe(true);
		expect(
			result.checks.some(({ name }) => name === "Pull request title"),
		).toBe(false);
	},
	repoTestTimeout,
);

// Checks subjects and worktree changes on a real Git branch.
test(
	"bad commit subjects, failing checks and edits that change files all fail",
	async () => {
		const { repo, config } = await branch(
			stack({
				on_edit: ["sed -i.bak s/x/y/ {files} && rm -f src/*.bak"],
				on_turn_end: ["! grep -n TODO {files}"],
			}),
			{ "src/a.ts": "const x = 1; // TODO\n" },
			"added stuff",
		);
		const result = await ci(config, { cwd: repo.root, base: "main", env: {} });
		const failed = result.checks
			.filter((entry) => !entry.ok)
			.map((entry) => entry.name);
		expect(failed).toEqual([
			"Commit messages",
			"Edit checks",
			"Checks",
			"Clean checkout after checks",
		]);
		const edits = result.checks.find((entry) => entry.name === "Edit checks");
		expect(edits?.output).toContain("The edit checks changed files");
	},
	repoTestTimeout,
);

// Builds a Git branch and checks an event tied to its head.
test(
	"the pull request body is checked against the sections",
	async () => {
		const { repo, config } = await branch(
			stack({}),
			{ "src/a.ts": "1\n" },
			"feat: a",
		);
		const event = join(mkdtempSync(join(tmpdir(), "gw-ev-")), "event.json");
		writeFileSync(
			event,
			JSON.stringify({
				pull_request: {
					head: { sha: await repo.git("rev-parse", "HEAD") },
					title: "feat: add a",
					body: "## Testing\nran it",
				},
			}),
		);
		const result = await ci(config, {
			cwd: repo.root,
			base: "main",
			env: { GITHUB_EVENT_PATH: event },
		});
		const body = result.checks.find(
			(entry) => entry.name === "Pull request body",
		);
		expect(body?.output).toContain('lacks "## Risk", "## How to revert"');
	},
	repoTestTimeout,
);

// Writes an event with the actual Git head, then runs committed CI for each title.
test.each([
	{
		case: "an invalid title fails",
		title: "Added stuff",
		enabled: true,
		problem: "does not match",
	},
	{
		case: "a valid title passes",
		title: "feat(ci): add file",
		enabled: true,
	},
	{
		case: "a long title fails",
		title: `feat: ${"a".repeat(67)}`,
		enabled: true,
		problem: "Keep it to 72 or fewer",
	},
	{
		case: "a missing title fails",
		enabled: true,
		problem: "Restore valid pull request event JSON",
	},
	{
		case: "the check is skipped when commit_message is off",
		title: "Added stuff",
		enabled: false,
	},
])(
	"pull request title: $case",
	async ({ title, enabled, problem }) => {
		const { repo, config } = await branch(
			{
				...stack({}),
				git: { commit_message: enabled ? "conventional" : "off" },
				review: { pr_sections: [] },
			},
			{ "src/a.ts": "1\n" },
			"feat: add a",
		);
		const event = join(mkdtempSync(join(tmpdir(), "gw-ev-")), "event.json");
		writeFileSync(
			event,
			JSON.stringify({
				pull_request: {
					head: { sha: await repo.git("rev-parse", "HEAD") },
					title,
				},
			}),
		);
		const result = await ci(config, {
			cwd: repo.root,
			base: "main",
			env: { GITHUB_EVENT_PATH: event },
		});
		const titleCheck = result.checks.find(
			({ name }) => name === "Pull request title",
		);
		const failed = result.checks
			.filter(({ ok }) => !ok)
			.map(({ name }) => name);
		expect(result.ok).toBe(!problem);
		expect(failed).toEqual(problem ? ["Pull request title"] : []);
		expect(titleCheck?.ok).toBe(enabled ? !problem : undefined);
		if (problem) expect(titleCheck?.output).toContain(problem);
		if (problem && title)
			expect(titleCheck?.output).toContain("gh pr edit --title");
	},
	repoTestTimeout,
);

test("annotations escape what GitHub would read as syntax", () => {
	const lines = annotations({
		ok: false,
		tier: "low",
		checks: [
			{
				name: "Code rules",
				ok: false,
				output: "",
				annotations: [
					{ file: "src/a,b.ts", line: 3, message: "50% off\nnext" },
				],
			},
			{ name: "Checks", ok: false, output: "line1\nline2", annotations: [] },
			{ name: "Risk", ok: true, output: "fine", annotations: [] },
		],
	});
	expect(lines).toEqual([
		"::error file=src/a%2Cb.ts,line=3,title=Code rules::50%25 off%0Anext",
		"::error title=Checks::line1%0Aline2",
	]);
});

test("CI reports load-tainted checks as deferred and emits a warning", () => {
	const result = {
		ok: false,
		tier: "medium",
		checks: [
			{
				name: "Verify",
				ok: false,
				deferred: true,
				output: "load-tainted",
				annotations: [],
			},
		],
	};
	expect(ciReport(result)).toBe("DEFERRED Verify\n  load-tainted");
	expect(annotations(result)).toEqual(["::warning title=Verify::load-tainted"]);
});

test(
	"CI defers Verify when the admission runner has an internal error",
	async () => {
		const { repo, config } = await branch(
			{ git: { pre_push: "bun run verify" } },
			{ "docs/a.md": "updated\n" },
			"docs: add a",
		);
		const result = await ci(config, {
			cwd: repo.root,
			base: "main",
			env: {},
			executeCheck: async () => {
				throw new Error("EMFILE: watchdog failed");
			},
		});
		expect(ciReport(result)).toContain("DEFERRED Verify");
		expect(annotations(result).at(-1)).toContain("EMFILE: watchdog failed");
	},
	repoTestTimeout,
);

test("publish writes the step summary and the tier output", () => {
	const dir = mkdtempSync(join(tmpdir(), "gw-pub-"));
	const env = {
		GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
		GITHUB_OUTPUT: join(dir, "output"),
	};
	publish({ ok: true, tier: "high", checks: [] }, env);
	expect(readFileSync(env.GITHUB_STEP_SUMMARY, "utf8")).toContain(
		"all checks pass",
	);
	expect(readFileSync(env.GITHUB_OUTPUT, "utf8")).toBe("tier=high\n");
});

// Uses Git to find the committed file before checking its path.
test(
	"a file the branch adds in the wrong place fails the Layout check",
	async () => {
		const { repo, config } = await branch(
			{
				...stack({}),
			},
			{
				".cagr/rules/layout.yml": `id: kebab-files
message: Files use kebab-case names.
instead: Rename it, such as user-card.ts.
layout:
  files: ["src/**"]
  name: "^[a-z0-9]+(-[a-z0-9]+)*$"
examples:
  invalid: [src/UserCard.ts]
  valid: [src/user-card.ts]
`,
				"src/UserCard.ts": "export const a = 1;\n",
				"src/ok-name.ts": "",
			},
			"feat: add a",
		);
		const result = await ci(config, { cwd: repo.root, base: "main", env: {} });
		const layout = result.checks.find((c) => c.name === "Layout");
		expect(result.ok).toBe(false);
		expect(layout?.ok).toBe(false);
		expect(layout?.output).toContain(
			'src/UserCard.ts kebab-files: Files use kebab-case names. (the name "UserCard"',
		);
		expect(layout?.output).not.toContain("ok-name");
		expect(layout?.annotations.map((a) => a.file)).toEqual(["src/UserCard.ts"]);
	},
	repoTestTimeout,
);

// Runs the committed suppression scan with a different working-tree copy.
test(
	"CI catches committed suppressions relative to base and ignores worktree replacements",
	async () => {
		const { repo, config } = await branch(
			{ extends: ["recommended"], suppressions: { allow: ["generated/**"] } },
			{ "a.ts": "// @ts-ignore\nx();\n", "generated/a.py": "# noqa\n" },
			"feat: silence lint",
		);
		await repo.write("a.ts", "x();\n");
		const result = await ci(config, { cwd: repo.root, base: "main", env: {} });
		const check = result.checks.find(
			(entry) => entry.name === "Lint suppressions",
		);
		expect(check?.ok).toBe(false);
		expect(check?.annotations).toMatchObject([{ file: "a.ts", line: 1 }]);
		expect(check?.output).not.toContain("generated/a.py");
	},
	repoTestTimeout,
);

// Creates Git commits on both sides of the suppression comparison.
test(
	"CI leaves baseline suppressions alone",
	async () => {
		const { repo, config } = await branch(
			{ extends: ["recommended"] },
			{ "a.py": "# noqa\nx()\n" },
			"feat: baseline",
		);
		await repo.git("branch", "baseline");
		await repo.commit("feat: add code", { "a.py": "# noqa\nx()\ny()\n" });
		const result = await ci(config, {
			cwd: repo.root,
			base: "baseline",
			env: {},
		});
		expect(
			result.checks.find((entry) => entry.name === "Lint suppressions")?.ok,
		).toBe(true);
	},
	repoTestTimeout,
);

// Creates a Git branch before injecting the suppression scan error.
test(
	"a suppression git error fails its check and CI still reports the other checks",
	async () => {
		const { repo, config } = await branch(
			{ extends: ["recommended"] },
			{ "a.ts": "// @ts-ignore\n" },
			"feat: add a",
		);
		const original = runner.run;
		const spy = spyOn(runner, "run").mockImplementation(
			async (argv, cwd, options) => {
				if (argv[0] === "git" && argv[1] === "show")
					return {
						ok: false,
						output: "Could not read blob",
						stdout: "",
						ms: 1,
						timedOut: false,
					};
				return original(argv, cwd, options);
			},
		);
		try {
			const result = await ci(config, {
				cwd: repo.root,
				base: "main",
				env: {},
			});
			expect(result.ok).toBe(false);
			expect(
				result.checks.find((entry) => entry.name === "Lint suppressions"),
			).toMatchObject({
				ok: false,
				output: expect.stringContaining("Could not read blob"),
			});
			expect(
				result.checks.find((entry) => entry.name === "Risk"),
			).toBeDefined();
		} finally {
			spy.mockRestore();
		}
	},
	repoTestTimeout,
);
