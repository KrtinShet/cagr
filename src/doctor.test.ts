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
	expect(section).toContain("ok   lint-suppression: new lint suppressions");
	expect(section).toContain("edits to biome.json");
	expect(section).toContain(
		"force-push: off (configure [git] block_force_push)",
	);
	expect(section).toContain("worktree-only: off");
	expect(section).toContain(
		"review-gate: gh pr create, gh pr ready until reviewed",
	);
	expect(section).not.toContain("FAIL");
});

test("doctor names the setting to enable lint suppressions", async () => {
	const root = await mkdtemp(join(tmpdir(), "gw-doctor-"));
	const config = resolveConfig(
		{ extends: ["recommended"], suppressions: { enabled: false } },
		root,
		join(root, "cagr.toml"),
	);
	const { report } = await doctor(config);
	const section = report.split("Guards\n")[1]?.split("\n\n")[0];
	expect(section).toContain(
		"lint-suppression: off (configure [suppressions] enabled = true)",
	);
	expect(section).not.toContain("new lint suppressions");
});

test("Go and Rust tool commands check PATH, including the clippy component", async () => {
	for (const command of [
		"go -C service vet ./...",
		"gofmt -w {files}",
		"golangci-lint run ./...",
		"rustfmt --edition 2024 {files}",
		"cargo test --manifest-path Cargo.toml",
	]) {
		expect(programsOf(command)).toEqual([
			{ name: command.split(" ")[0] ?? "", dirs: [] },
		]);
	}
	expect(programsOf("cargo clippy --all-targets -- -D warnings")).toEqual([
		{ name: "cargo", dirs: [] },
		{ name: "cargo-clippy", dirs: [] },
	]);
	const root = await mkdtemp(join(tmpdir(), "cagr-doctor-native-"));
	const config = resolveConfig(
		{
			stack: [
				{
					language: "go",
					on_edit: ["gofmt -w {files}"],
					on_turn_end: ["go vet ./...", "golangci-lint run ./..."],
				},
				{
					language: "rust",
					on_edit: ["rustfmt --edition 2024 {files}"],
					on_turn_end: ["cargo clippy --all-targets -- -D warnings"],
				},
			],
		},
		root,
		"cagr.toml",
	);
	const { report } = await doctor(config);
	const section = report.split("Tools\n")[1]?.split("\n\n")[0];
	for (const tool of [
		"go vet",
		"gofmt",
		"golangci-lint",
		"rustfmt",
		"cargo clippy",
	])
		expect(section).toContain(tool);
});

test("doctor checks tools behind a scoped golangci command", () => {
	expect(programsOf("cd 'nested module' && golangci-lint run ./...")).toEqual([
		{ name: "golangci-lint", dirs: [] },
	]);
});

test("doctor rounds fractional whole-hook and sub-step timings", async () => {
	const { recordTimings } = await import("./hook/timings");
	const root = await mkdtemp(join(tmpdir(), "cagr-doctor-timing-"));
	recordTimings(root, [
		{ event: "turn.end", check: "change collection", ms: 661.377083 },
		{ event: "turn.end", check: "change collection", ms: 709.5101669999999 },
		{ event: "file.after_edit", check: "total", ms: 9.123456 },
	]);
	const { report } = await doctor(
		resolveConfig({}, root, join(root, "cagr.toml")),
	);
	expect(report).toContain("`change collection`: median 710 ms, max 710 ms");
	expect(report).toContain("(whole hook): median 9 ms, max 9 ms");
	expect(report).not.toContain("709.510");
});
