import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveConfig } from "./config/load";
import { doctor, programsOf } from "./doctor";
import { GitSetupError, installGitHooks, sync } from "./sync";

test("a check needs its runner, and the tool behind an exec runner", () => {
	expect(programsOf("bun run lint")).toEqual([{ name: "bun", dirs: [] }]);
	expect(programsOf("bunx biome check --write {files}")).toEqual([
		{ name: "bunx", dirs: [] },
		{ name: "biome", dirs: ["node_modules/.bin"] },
	]);
	expect(programsOf("uv run --project services/ml ruff check {files}")).toEqual(
		[
			{ name: "uv", dirs: [] },
			{ name: "ruff", dirs: ["services/ml/.venv/bin", ".venv/bin"] },
		],
	);
	expect(programsOf("uvx ruff format {files}")).toEqual([
		{ name: "uvx", dirs: [] },
	]);
	expect(programsOf("pnpm exec eslint --fix {files}")[1]?.name).toBe("eslint");
});

describe("doctor on a folder that is not a git repo", () => {
	test("says to run git init, and install-git-hooks says so too", async () => {
		const root = await mkdtemp(join(tmpdir(), "gw-doctor-"));
		const config = resolveConfig({}, root, join(root, "cagr.toml"));
		sync(config);
		const { ok, report } = await doctor(config);
		expect(ok).toBe(false);
		expect(report).toContain("Run `git init`, then `cagr install-git-hooks`.");
		expect(installGitHooks(config)).rejects.toBeInstanceOf(GitSetupError);
	});
});

test("doctor lists the .cagr files that add to the config", async () => {
	const root = await mkdtemp(join(tmpdir(), "gw-doctor-"));
	await mkdir(join(root, ".cagr"), { recursive: true });
	await writeFile(join(root, "cagr.toml"), "");
	await writeFile(
		join(root, ".cagr/guards.toml"),
		'[[commands.blocked]]\nmatch = "db push"\nreason = "Migrate."\n',
	);
	const config = loadConfig(root);
	if (!config) throw new Error("no config");
	const { report } = await doctor(config);
	expect(report).toContain(`Config: ${join(root, "cagr.toml")}`);
	expect(report).toContain("Also config: .cagr/guards.toml");
});

test("doctor lists active guard summaries and disabled guards without failing them", async () => {
	const root = await mkdtemp(join(tmpdir(), "gw-doctor-"));
	const config = resolveConfig(
		{
			extends: ["recommended"],
			stack: [{ language: "typescript", package_manager: "bun" }],
			git: { block_force_push: false },
		},
		root,
		join(root, "cagr.toml"),
	);
	const { report } = await doctor(config);
	const section = report.split("Guards\n")[1]?.split("\n\n")[0];
	expect(section).toContain(
		"ok   package-manager: npm, npx, pnpm, pnpx, yarn (use bun for JavaScript)",
	);
	expect(section).toContain("protected-branch: pushes to main");
	expect(section).toContain(
		"force-push: off (configure [git] block_force_push)",
	);
	expect(section).toContain("worktree-only: off");
	expect(section).toContain(
		"review-gate: gh pr create, gh pr ready until reviewed",
	);
	expect(section).not.toContain("FAIL");
});
