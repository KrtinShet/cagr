import { expect, test } from "bun:test";
import { brief } from "./brief";
import { resolveConfig } from "./config/load";
import { config, gerb } from "./test/config";

test("the brief lists what the config enforces, briefly", () => {
	const text = brief(gerb, []);
	expect(text.split("\n")).toEqual([
		"cagr checks this repo. When it blocks something, its message says what to do instead.",
		"- Do not add suppression comments. Fix the cause, or tell the user which rule gets in the way and why.",
		"- Package managers: bun for JavaScript.",
		'- Git: never push to main, push a branch and open a pull request; branches look like feat/deal-pipeline; commit subjects look like "feat(deals): add pipeline board"; no force pushes; no --no-verify.',
		"- Do not edit: cagr.toml, .cagr/**, .githooks/**, .claude/settings.json, .codex/hooks.json, .github/workflows/**, .github/CODEOWNERS, biome.json, biome.jsonc, eslint.config.*, .eslintrc*, ruff.toml, .ruff.toml, mypy.ini, .golangci.y*ml, clippy.toml, .oxlintrc.json, .env*, {bun.lock,bun.lockb,package-lock.json,pnpm-lock.yaml,yarn.lock,uv.lock,poetry.lock,Pipfile.lock,Cargo.lock,go.sum}, packages/db/prisma/migrations/**.",
		"- Do not run: `prisma db push`, `prisma migrate dev`, `prisma migrate reset`.",
		"- Commit, run `cagr review`, fix or answer every Important finding, then re-check any new commits. Push once the review passes. Give the review a 15 minute timeout.",
		"- The pull request body needs these headings: Testing, Risk, How to revert.",
		"",
		"- Before `cagr review`, make sure each new behavior or bug fix has a test that fails without it.",
		"- Put the intent and any deliberate trade-offs in the commit body.",
		"- Fix every finding in one commit, covering the whole bug class.",
		"- Run the targeted tests before asking for the next round.",
		"- Do not merge or approve pull requests. A person does that.",
	]);
});

test("stacks, rules and extra lines appear when set", () => {
	const repo = config({
		stack: [
			{
				language: "python",
				package_manager: "uv",
				paths: ["ml/**"],
				on_edit: ["ruff format {files}"],
				on_turn_end: ["pytest -q"],
			},
		],
		brief: ["Ask before adding a dependency."],
	});
	const text = brief(repo, [{ id: "no-print" } as never]);
	expect(text).toContain("- Package managers: uv for Python.");
	expect(text).toContain(
		"- python (ml/**): after each edit `ruff format {files}` run on the changed files; before you finish `pytest -q` must pass.",
	);
	expect(text).toContain(
		"- 1 code rule (no-print). `cagr explain <id>` shows one.",
	);
	expect(text).toEndWith("- Ask before adding a dependency.");
	expect(text).not.toContain("Git:");
});

test("Go and Rust briefs describe checks without inventing manager restrictions", () => {
	const text = brief(
		config({
			findings: { mode: "new" },
			stack: [
				{
					language: "go",
					on_edit: ["gofmt -w {files}"],
					on_turn_end: ["go vet ./...", "go test ./..."],
				},
				{
					language: "rust",
					on_edit: ["rustfmt --edition 2024 {files}"],
					on_turn_end: [
						"cargo clippy --all-targets -- -D warnings",
						"cargo test",
					],
				},
			],
		}),
		[],
	);
	expect(text).toContain("- go (**): after each edit `gofmt");
	expect(text).toContain("- rust (**): after each edit `rustfmt");
	expect(text).not.toContain("Package managers:");
	expect(text).toContain(
		"All other commands, turn-end checks, CI and code rules still must fully pass",
	);
});

test("new findings brief lists Biome comparison and its remaining limits", () => {
	const config = resolveConfig(
		{
			findings: { mode: "new" },
			stack: [
				{
					language: "typescript",
					on_edit: [
						"bunx biome check --write --no-errors-on-unmatched {files}",
					],
				},
			],
		},
		"/repo",
		"/repo/cagr.toml",
	);
	const text = brief(config, []);
	expect(text).toContain(
		"`bunx biome check --write --no-errors-on-unmatched {files}` compared against first-touch source",
	);
	expect(text).toContain(
		"Biome lint findings use a temporary baseline workspace",
	);
	expect(text).toContain("uncertain reports stay strict");
	expect(text).not.toContain("Biome stays strict");
});
