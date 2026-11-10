import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { annotations, ci, ciReport, publish } from "./ci";
import { resolveConfig } from "./config/load";
import type { RawConfig } from "./config/presets";
import { sync } from "./sync";
import { tempRepo } from "./test/repo";

async function branch(
	raw: RawConfig,
	files: Record<string, string>,
	subject: string,
) {
	const repo = await tempRepo();
	const config = resolveConfig(raw, repo.root, join(repo.root, "cagr.toml"));
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

test("a clean branch passes every check and reports its risk tier", async () => {
	const { repo, config } = await branch(
		stack({ on_turn_end: ["test -f {files}"] }),
		{ "src/a.ts": "export const a = 1;\n" },
		"feat: add a",
	);
	const result = await ci(config, { cwd: repo.root, base: "main", env: {} });
	expect(ciReport(result)).not.toContain("FAIL");
	expect(result.ok).toBe(true);
	expect(result.tier).toBe("medium");
});

test("an empty GITHUB_BASE_REF, as on merge_group, falls back to the protected branch", async () => {
	const { repo, config } = await branch(
		stack({}),
		{ "src/a.ts": "export const a = 1;\n" },
		"feat: add a",
	);
	const result = await ci(config, {
		cwd: repo.root,
		env: { GITHUB_BASE_REF: "" },
	});
	expect(result.ok).toBe(true);
});

test("bad commit subjects, failing checks and edits that change files all fail", async () => {
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
	expect(failed).toEqual(["Commit messages", "Edit checks", "Checks"]);
	const edits = result.checks.find((entry) => entry.name === "Edit checks");
	expect(edits?.output).toContain("The edit checks changed files");
});

test("the pull request body is checked against the sections", async () => {
	const { repo, config } = await branch(
		stack({}),
		{ "src/a.ts": "1\n" },
		"feat: a",
	);
	const event = join(mkdtempSync(join(tmpdir(), "gw-ev-")), "event.json");
	writeFileSync(
		event,
		JSON.stringify({ pull_request: { body: "## Testing\nran it" } }),
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
});

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

test("a file the branch adds in the wrong place fails the Layout check", async () => {
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
});

test("CI catches committed suppressions relative to base and ignores worktree replacements", async () => {
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
});

test("CI leaves baseline suppressions alone", async () => {
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
});
