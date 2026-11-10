import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveConfig } from "./config/load";
import { configToml, detect, formatGenerated, init } from "./init";

const none = () => null;

async function project(files: Record<string, string>) {
	const root = await mkdtemp(join(tmpdir(), "gw-init-"));
	for (const [path, text] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), text);
	}
	return root;
}

describe("detect", () => {
	test("a bun TypeScript project with biome, a lint script and verify", async () => {
		const root = await project({
			"package.json": JSON.stringify({
				scripts: { lint: "biome check .", verify: "bun test" },
				devDependencies: { typescript: "5" },
			}),
			"bun.lock": "",
			"tsconfig.json": "{}",
			"biome.json": "{}",
			"CLAUDE.md": "",
		});
		const found = await detect(root, none);
		expect(found.agents).toEqual(["claude"]);
		expect(found.stacks).toEqual([
			{
				dir: "",
				language: "typescript",
				package_manager: "bun",
				tools: ["biome", "tsc"],
				on_edit: ["bunx biome check --write --no-errors-on-unmatched {files}"],
				on_turn_end: ["bun run lint", "bunx tsc --noEmit"],
				pre_push: "bun run verify",
			},
		]);
	});

	test("the packageManager field wins, and a typecheck script replaces tsc", async () => {
		const root = await project({
			"package.json": JSON.stringify({
				packageManager: "pnpm@9.0.0",
				scripts: { typecheck: "tsc" },
			}),
			"package-lock.json": "{}",
			"tsconfig.json": "{}",
			"eslint.config.js": "",
		});
		const [stack] = (await detect(root, none)).stacks;
		expect(stack).toMatchObject({
			package_manager: "pnpm",
			on_edit: ["pnpm exec eslint --fix {files}"],
			on_turn_end: ["pnpm run typecheck"],
		});
	});

	test("a uv Python service in a subfolder of a TypeScript repo", async () => {
		const root = await project({
			"package.json": "{}",
			"bun.lock": "",
			"services/ml/pyproject.toml":
				'[project]\nname = "ml"\n[dependency-groups]\ndev = ["ruff>=0.6", "pytest"]\n[tool.ruff]\n',
			"services/ml/uv.lock": "",
			"web/package.json": "{}",
		});
		const found = await detect(root, (program) =>
			program === "codex" ? "/bin/codex" : null,
		);
		expect(found.agents).toEqual(["codex"]);
		expect(found.stacks.map((stack) => [stack.dir, stack.language])).toEqual([
			["", "javascript"],
			["services/ml", "python"],
		]);
		expect(found.stacks[1]).toMatchObject({
			package_manager: "uv",
			on_edit: [
				"uv run --project services/ml ruff check --fix {files}",
				"uv run --project services/ml ruff format {files}",
			],
			on_turn_end: ["uv run --project services/ml pytest -q services/ml"],
		});
	});

	test("ruff that is not a dependency runs through uvx", async () => {
		const root = await project({
			"pyproject.toml": '[project]\nname = "a"\n[tool.ruff]\n',
		});
		expect((await detect(root, none)).stacks[0]?.on_edit).toEqual([
			"uvx ruff check --fix {files}",
			"uvx ruff format {files}",
		]);
	});

	test("no agent found means both", async () => {
		expect((await detect(await project({}), none)).agents).toEqual([
			"claude",
			"codex",
		]);
	});
});

test("the written config loads and keeps what was found", async () => {
	const root = await project({
		"package.json": JSON.stringify({ scripts: { verify: "x" } }),
		"bun.lock": "",
		"requirements.txt": "pytest\n",
	});
	const detection = await detect(root, none);
	const loaded = resolveConfig(
		Bun.TOML.parse(configToml(detection)) as never,
		root,
		"cagr.toml",
	);
	expect(loaded.git.protected_branch).toBe("main");
	expect(loaded.git.pre_push).toEqual(["bun run verify"]);
	expect(
		loaded.stack.map((stack) => [
			stack.language,
			stack.package_manager,
			stack.on_turn_end,
		]),
	).toEqual([
		["javascript", "bun", []],
		["python", "pip", ["pytest -q"]],
	]);
	expect(loaded.files.protected.length).toBe(2);
});

test("the generated JSON files go through the repo's on_edit commands", async () => {
	const root = await project({
		".claude/settings.json": "{}",
		".githooks/pre-push": "",
	});
	const config = resolveConfig(
		{ stack: [{ language: "typescript", on_edit: ["touch {files}.seen"] }] },
		root,
		join(root, "cagr.toml"),
	);
	await formatGenerated(config, [
		".claude/settings.json",
		".githooks/pre-push",
	]);
	expect(
		await Bun.file(join(root, ".claude/settings.json.seen")).exists(),
	).toBe(true);
	expect(await Bun.file(join(root, ".githooks/pre-push.seen")).exists()).toBe(
		false,
	);
});

test("init writes a starter .cagr/review.md and keeps a REVIEW.md that exists", async () => {
	const fresh = await project({ "package.json": "{}" });
	const result = await init(fresh);
	expect(result.written).toContain(".cagr/review.md");
	expect(await readFile(join(fresh, ".cagr/review.md"), "utf8")).toContain(
		"## Always check",
	);
	const kept = await project({ "package.json": "{}", "REVIEW.md": "mine\n" });
	const again = await init(kept);
	expect(again.written).not.toContain("REVIEW.md");
	expect(again.written).not.toContain(".cagr/review.md");
	expect(await readFile(join(kept, "REVIEW.md"), "utf8")).toBe("mine\n");
});

test("init keeps cagr.toml short and puts the lists in .cagr/", async () => {
	const root = await project({ "package.json": "{}" });
	const result = await init(root);
	expect(result.written).toEqual(
		expect.arrayContaining([".cagr/guards.toml", ".cagr/risk.toml"]),
	);
	const toml = await readFile(join(root, "cagr.toml"), "utf8");
	for (const list of ["files.protected", "commands.blocked", "risk.paths"])
		expect(toml).not.toContain(list);
	expect(await readFile(join(root, ".cagr/guards.toml"), "utf8")).toContain(
		"# [[commands.blocked]]",
	);
	expect(await readFile(join(root, ".cagr/risk.toml"), "utf8")).toContain(
		"# [[risk.paths]]",
	);
	// A rerun with --force leaves the .cagr files a person may have filled in.
	await writeFile(join(root, ".cagr/risk.toml"), "# mine\n");
	const forced = await init(root, { force: true });
	expect(forced.written).not.toContain(".cagr/risk.toml");
	expect(await readFile(join(root, ".cagr/risk.toml"), "utf8")).toBe(
		"# mine\n",
	);
});

test("init --force keeps the old cagr.toml when the new one clashes with .cagr/", async () => {
	const dir = await mkdtemp(join(tmpdir(), "gw-init-clash-"));
	await mkdir(join(dir, ".cagr"), { recursive: true });
	await writeFile(join(dir, "cagr.toml"), "# old\n");
	await writeFile(
		join(dir, ".cagr/git.toml"),
		'[agents]\nenabled = ["claude"]\n',
	);
	await expect(init(dir, { force: true })).rejects.toThrow(
		"agents.enabled is set in both",
	);
	expect(await readFile(join(dir, "cagr.toml"), "utf8")).toBe("# old\n");
});

test("init and dry-run describe resolved guards and commands, including fragments", async () => {
	const root = await project({
		"package.json":
			'{"packageManager":"bun@1","scripts":{"lint":"x","typecheck":"x"}}',
		"biome.json": "{}",
		"tsconfig.json": "{}",
		".cagr/custom.toml":
			'[git]\nblock_force_push = false\n[[commands.blocked]]\nmatch = "db push"\nreason = "Migrate instead."\n',
	});
	const preview = await init(root, { dryRun: true });
	expect(await Bun.file(join(root, "cagr.toml")).exists()).toBe(false);
	expect(preview.enforcement).toContain(
		"npm, npx, pnpm, pnpx, yarn (use bun for JavaScript)",
	);
	expect(preview.enforcement).toContain("pushes to main");
	expect(preview.enforcement).not.toContain("force pushes");
	expect(preview.enforcement).toContain("db push (Migrate instead.)");
	expect(preview.enforcement).toContain(
		"edits to .env* (except .env.example, .env.sample, .env.template)",
	);
	expect(preview.enforcement).toContain(
		"Will hold: gh pr create, gh pr ready until reviewed",
	);
	expect(preview.enforcement).toContain("Will require: branch names matching");
	expect(preview.enforcement).toContain(
		"Will run after each edit in typescript (**): bunx biome check",
	);
	expect(preview.enforcement).toContain(
		"Before the agent stops after edits in typescript (**): bun run lint; bun run typecheck.",
	);
	expect((await init(root)).enforcement).toBe(preview.enforcement);
});

test("init explains empty command slots and a repo with no stacks", async () => {
	const bare = await init(await project({}), { dryRun: true });
	expect(bare.enforcement).toContain(
		"No stacks configured. Add [[stack]] with on_edit and on_turn_end commands in cagr.toml.",
	);
	const empty = await init(await project({ "package.json": "{}" }), {
		dryRun: true,
	});
	expect(empty.enforcement).toContain(
		"none. Add commands to [[stack]].on_edit in cagr.toml",
	);
	expect(empty.enforcement).toContain(
		"no commands. Add commands to [[stack]].on_turn_end in cagr.toml",
	);
});

test("enforcement summary includes pre-push commands and empty policy groups", async () => {
	const { enforcementSummary } = await import("./init");
	const config = resolveConfig(
		{
			git: {
				pre_push: ["bun run verify"],
				branch_name: "off",
				commit_message: "off",
			},
			review: { enabled: false, pr_sections: [] },
		},
		"/tmp/cagr-summary-no-fragments",
		"cagr.toml",
	);
	const summary = enforcementSummary(config);
	expect(summary).toContain("Will hold: none.");
	expect(summary).toContain("Will require: none.");
	expect(summary).toContain("Before a push: bun run verify.");
});
