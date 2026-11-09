import { expect, test } from "bun:test";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAll } from "./check-all";
import { resolveConfig } from "./config/load";
import { tempRepo } from "./test/repo";

const rule = `id: no-console-log
language: typescript
message: console.log in app code.
instead: Use the logger.
rule:
  pattern: console.log($$$A)
examples:
  invalid: ["console.log(1)"]
  valid: ["log(1)"]
`;
const layout = `id: kebab-files
message: Files use kebab-case names.
instead: Rename it.
layout:
  files: ["src/**"]
  name: "^[a-z0-9]+(-[a-z0-9]+)*$"
examples:
  invalid: [src/UserCard.ts]
  valid: [src/user-card.ts]
`;

async function repo() {
	const repo = await tempRepo();
	await repo.commit("chore: add files", {
		".cagr/rules/r.yml": rule,
		".cagr/rules/layout.yml": layout,
		".gitignore": "dist/\n",
		"src/old.ts": "console.log(1);\n",
		"src/OldName.ts": "export {};\n",
		"src/fine.ts": "export const a = 1;\n",
	});
	// Untracked but not ignored counts; ignored does not.
	await repo.write("src/new.ts", "console.log(2);\n");
	await repo.write("dist/out.ts", "console.log(3);\n");
	return repo;
}

test("--all reports old problems in every file git knows, not ignored ones", async () => {
	const { root } = await repo();
	const config = resolveConfig({}, root, join(root, "cagr.toml"));
	const result = await checkAll(config);
	expect(result.ok).toBe(false);
	expect(result.report).toBe(
		[
			"## Rules",
			"src/new.ts:1:1 no-console-log: console.log in app code. Instead: Use the logger.",
			"src/old.ts:1:1 no-console-log: console.log in app code. Instead: Use the logger.",
			"",
			"## Layout",
			'src/OldName.ts kebab-files: Files use kebab-case names. (the name "OldName" does not match /^[a-z0-9]+(-[a-z0-9]+)*$/.) Instead: Rename it.',
		].join("\n"),
	);
});

test("--all passes a clean repo and counts its files", async () => {
	const { root, commit } = await tempRepo();
	await commit("chore: add", {
		"src/a.ts": "export {};\n",
		".cagr/rules/layout.yml": layout,
	});
	const config = resolveConfig({}, root, join(root, "cagr.toml"));
	expect(await checkAll(config)).toEqual({
		ok: true,
		report: "No problems in 3 files.",
	});
});

test("--all outside a git repo says how to fix it", async () => {
	const root = mkdtempSync(join(tmpdir(), "gw-all-"));
	const result = await checkAll(
		resolveConfig({}, root, join(root, "cagr.toml")),
	);
	expect(result.ok).toBe(false);
	expect(result.report).toContain("Run `git init`, or name the files");
});

test("--all skips folders git lists: nested repos and symlinks to folders", async () => {
	const { root, git, commit } = await tempRepo();
	await commit("chore: add", {
		"src/a.ts": "export {};\n",
		".cagr/rules/layout.yml": layout,
	});
	// An untracked nested repo is listed as `src/Three.js/`; a symlink to a folder as itself.
	const nested = await tempRepo();
	await git("clone", "-q", nested.root, "src/Three.js");
	symlinkSync(join(root, "src"), join(root, "src/LinkDir.js"));
	const config = resolveConfig({}, root, join(root, "cagr.toml"));
	expect(await checkAll(config)).toEqual({
		ok: true,
		report: "No problems in 3 files.",
	});
});

test("--all names git's error when git fails inside a repo", async () => {
	const { root, git } = await tempRepo();
	await git("config", "core.repositoryformatversion", "99");
	const result = await checkAll(
		resolveConfig({}, root, join(root, "cagr.toml")),
	);
	expect(result.ok).toBe(false);
	expect(result.report).toContain("`git ls-files`, which failed:");
	expect(result.report).not.toContain("git init");
});

test("--all says so when git cannot start", async () => {
	const root = mkdtempSync(join(tmpdir(), "gw-all-"));
	const path = process.env.PATH;
	process.env.PATH = join(root, "nothing-here");
	try {
		const result = await checkAll(
			resolveConfig({}, root, join(root, "cagr.toml")),
		);
		expect(result.ok).toBe(false);
		expect(result.report).toContain("git could not start");
	} finally {
		process.env.PATH = path;
	}
});

test("--all reports a broken rule file under Rules", async () => {
	const { root, commit } = await tempRepo();
	await commit("chore: add", {
		".cagr/rules/bad.yml": "id: [\n",
		".cagr/rules/layout.yml": layout,
		"src/BadName.ts": "export {};\n",
	});
	const config = resolveConfig({}, root, join(root, "cagr.toml"));
	const result = await checkAll(config);
	expect(result.ok).toBe(false);
	expect(result.report).toContain("## Rules\nRule files have problems");
	expect(result.report).toContain("bad.yml: not valid YAML");
});

test("cagr check --all exits 1 on a finding and rejects file names", async () => {
	const { root, write } = await repo();
	await write("cagr.toml", "");
	const cli = join(import.meta.dir, "cli.ts");
	const all = Bun.spawnSync(["bun", cli, "check", "--all"], { cwd: root });
	expect(all.exitCode).toBe(1);
	expect(all.stdout.toString()).toContain("src/old.ts:1:1 no-console-log");
	const both = Bun.spawnSync(["bun", cli, "check", "--all", "src/a.ts"], {
		cwd: root,
	});
	expect(both.exitCode).not.toBe(0);
	expect(both.stderr.toString()).toContain("Drop the file names");
});
