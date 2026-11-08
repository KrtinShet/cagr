import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { configFileName, loadConfig } from "./config/load";
import type { AgentName, Config, PackageManager } from "./config/schema";
import { stackFiles, withFiles } from "./hook/stack-files";
import { toPosix } from "./paths";
import { run, runShell } from "./run";
import { installGitHooks, keptNotes, sync } from "./sync";

export type DetectedStack = {
	dir: string;
	language: "typescript" | "javascript" | "python";
	package_manager: PackageManager | null;
	tools: string[];
	on_edit: string[];
	on_turn_end: string[];
	pre_push: string | null;
};

export type Detection = {
	stacks: DetectedStack[];
	agents: AgentName[];
	protectedBranch: string;
	isGitRepo: boolean;
};

const skipDirs = new Set([
	"node_modules",
	".git",
	".venv",
	"venv",
	"dist",
	"build",
	"target",
	".worktrees",
	"__pycache__",
	".next",
	".turbo",
]);

function projectDirs(root: string, depth = 3): string[] {
	const found: string[] = [];
	const walk = (dir: string, level: number) => {
		if (
			["package.json", "pyproject.toml", "requirements.txt", "setup.py"].some(
				(file) => existsSync(join(dir, file)),
			)
		)
			found.push(dir);
		if (level === depth) return;
		let entries: import("node:fs").Dirent[] = [];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries)
			if (
				entry.isDirectory() &&
				!skipDirs.has(entry.name) &&
				!entry.name.startsWith(".")
			)
				walk(join(dir, entry.name), level + 1);
	};
	walk(root, 0);
	return found;
}

const readJson = (file: string): Record<string, unknown> => {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return {};
	}
};
const readToml = (file: string): Record<string, unknown> => {
	try {
		return Bun.TOML.parse(readFileSync(file, "utf8")) as Record<
			string,
			unknown
		>;
	} catch {
		return {};
	}
};
const anyExists = (dir: string, files: string[]) =>
	files.some((file) => existsSync(join(dir, file)));

function jsManager(
	dir: string,
	root: string,
	pkg: Record<string, unknown>,
): PackageManager | null {
	const field =
		typeof pkg.packageManager === "string"
			? pkg.packageManager.split("@")[0]
			: "";
	if (
		field === "bun" ||
		field === "npm" ||
		field === "pnpm" ||
		field === "yarn"
	)
		return field;
	for (let at = dir; ; at = join(at, "..")) {
		if (anyExists(at, ["bun.lock", "bun.lockb"])) return "bun";
		if (existsSync(join(at, "pnpm-lock.yaml"))) return "pnpm";
		if (existsSync(join(at, "yarn.lock"))) return "yarn";
		if (existsSync(join(at, "package-lock.json"))) return "npm";
		if (at === root || relative(root, at).startsWith("..")) return null;
	}
}

const exec: Record<string, string> = {
	bun: "bunx",
	npm: "npx",
	pnpm: "pnpm exec",
	yarn: "yarn",
};

function scriptCommand(manager: string, rel: string, script: string) {
	if (rel === "") return `${manager} run ${script}`;
	return {
		bun: `bun run --cwd ${rel} ${script}`,
		npm: `npm --prefix ${rel} run ${script}`,
		pnpm: `pnpm -C ${rel} run ${script}`,
		yarn: `yarn --cwd ${rel} ${script}`,
	}[manager] as string;
}

function detectJs(dir: string, root: string): DetectedStack {
	const rel = toPosix(relative(root, dir));
	const pkg = readJson(join(dir, "package.json"));
	const deps = {
		...(pkg.dependencies as object),
		...(pkg.devDependencies as object),
	} as Record<string, string>;
	const scripts = (pkg.scripts ?? {}) as Record<string, string>;
	const manager = jsManager(dir, root, pkg);
	const x = exec[manager ?? "npm"];
	const tools: string[] = [];
	const onEdit: string[] = [];
	const onTurnEnd: string[] = [];
	const hasTs = existsSync(join(dir, "tsconfig.json")) || "typescript" in deps;
	if (
		anyExists(dir, ["biome.json", "biome.jsonc"]) ||
		anyExists(root, ["biome.json", "biome.jsonc"]) ||
		"@biomejs/biome" in deps
	) {
		tools.push("biome");
		onEdit.push(`${x} biome check --write --no-errors-on-unmatched {files}`);
	}
	const eslintFiles = [
		"eslint.config.js",
		"eslint.config.mjs",
		"eslint.config.cjs",
		"eslint.config.ts",
		".eslintrc",
		".eslintrc.js",
		".eslintrc.cjs",
		".eslintrc.json",
	];
	if (anyExists(dir, eslintFiles) || "eslint" in deps) {
		tools.push("eslint");
		onEdit.push(`${x} eslint --fix {files}`);
	}
	if (
		!tools.includes("biome") &&
		(anyExists(dir, [
			".prettierrc",
			".prettierrc.json",
			"prettier.config.js",
			"prettier.config.mjs",
		]) ||
			"prettier" in deps)
	) {
		tools.push("prettier");
		onEdit.push(`${x} prettier --write --ignore-unknown {files}`);
	}
	const manage = manager ?? "npm";
	if (scripts.lint) onTurnEnd.push(scriptCommand(manage, rel, "lint"));
	const typecheck = ["typecheck", "check-types", "type-check", "tsc"].find(
		(name) => scripts[name],
	);
	if (typecheck) onTurnEnd.push(scriptCommand(manage, rel, typecheck));
	else if (hasTs) {
		tools.push("tsc");
		onTurnEnd.push(`${x} tsc --noEmit${rel === "" ? "" : ` -p ${rel}`}`);
	}
	return {
		dir: rel,
		language: hasTs ? "typescript" : "javascript",
		package_manager: manager,
		tools,
		on_edit: onEdit,
		on_turn_end: onTurnEnd,
		pre_push: scripts.verify ? scriptCommand(manage, rel, "verify") : null,
	};
}

function detectPython(dir: string, root: string): DetectedStack {
	const rel = toPosix(relative(root, dir));
	const pyproject = readToml(join(dir, "pyproject.toml"));
	const tool = (pyproject.tool ?? {}) as Record<string, unknown>;
	const project = (pyproject.project ?? {}) as Record<string, unknown>;
	const groups = Object.values(
		(pyproject["dependency-groups"] ?? {}) as Record<string, unknown>,
	).flat();
	const text = [
		...((project.dependencies as string[]) ?? []),
		...groups,
		existsSync(join(dir, "requirements.txt"))
			? readFileSync(join(dir, "requirements.txt"), "utf8")
			: "",
	]
		.join("\n")
		.toLowerCase();
	const hasDep = (name: string) =>
		new RegExp(`(^|[\\s"',])${name}([<>=!~\\[\\s;"']|$)`, "m").test(text);
	let manager: PackageManager | null = null;
	if (
		existsSync(join(dir, "uv.lock")) ||
		existsSync(join(root, "uv.lock")) ||
		"uv" in tool
	)
		manager = "uv";
	else if (existsSync(join(dir, "poetry.lock")) || "poetry" in tool)
		manager = "poetry";
	else if (existsSync(join(dir, "Pipfile"))) manager = "pipenv";
	else if (existsSync(join(dir, "requirements.txt"))) manager = "pip";
	else if (existsSync(join(dir, "pyproject.toml"))) manager = "uv";
	const runIn = (name: string) => {
		if (manager === "uv")
			return hasDep(name)
				? `uv run${rel === "" ? "" : ` --project ${rel}`} ${name}`
				: `uvx ${name}`;
		if (manager === "poetry")
			return `poetry${rel === "" ? "" : ` -C ${rel}`} run ${name}`;
		if (manager === "pipenv") return `pipenv run ${name}`;
		return name;
	};
	const tools: string[] = [];
	const onEdit: string[] = [];
	const onTurnEnd: string[] = [];
	if (
		"ruff" in tool ||
		anyExists(dir, ["ruff.toml", ".ruff.toml"]) ||
		hasDep("ruff")
	) {
		tools.push("ruff");
		onEdit.push(
			`${runIn("ruff")} check --fix {files}`,
			`${runIn("ruff")} format {files}`,
		);
	}
	if ("mypy" in tool || anyExists(dir, ["mypy.ini"]) || hasDep("mypy")) {
		tools.push("mypy");
		onTurnEnd.push(`${runIn("mypy")} ${rel === "" ? "." : rel}`);
	}
	if (
		"pytest" in tool ||
		hasDep("pytest") ||
		anyExists(dir, ["pytest.ini", "tests", "conftest.py"])
	) {
		tools.push("pytest");
		onTurnEnd.push(`${runIn("pytest")} -q${rel === "" ? "" : ` ${rel}`}`);
	}
	return {
		dir: rel,
		language: "python",
		package_manager: manager,
		tools,
		on_edit: onEdit,
		on_turn_end: onTurnEnd,
		pre_push: null,
	};
}

type Which = (program: string) => string | null;

export async function detect(
	root: string,
	which: Which = Bun.which,
): Promise<Detection> {
	const dirs = projectDirs(root);
	const rootHasJs = existsSync(join(root, "package.json"));
	const stacks: DetectedStack[] = [];
	for (const dir of dirs) {
		// One root stack covers a JavaScript workspace; nested packages would repeat its checks.
		if (existsSync(join(dir, "package.json")) && (dir === root || !rootHasJs))
			stacks.push(detectJs(dir, root));
		if (anyExists(dir, ["pyproject.toml", "requirements.txt", "setup.py"]))
			stacks.push(detectPython(dir, root));
	}
	const agents: AgentName[] = [];
	if (anyExists(root, [".claude", "CLAUDE.md"]) || which("claude") !== null)
		agents.push("claude");
	if (anyExists(root, [".codex", "AGENTS.md"]) || which("codex") !== null)
		agents.push("codex");
	const git = await run(["git", "rev-parse", "--is-inside-work-tree"], root);
	const remoteHead = await run(
		["git", "symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"],
		root,
	);
	const current = await run(
		["git", "symbolic-ref", "--short", "-q", "HEAD"],
		root,
	);
	const branch = remoteHead.ok
		? remoteHead.output.trim().replace(/^origin\//, "")
		: current.output.trim();
	return {
		stacks,
		agents: agents.length > 0 ? agents : ["claude", "codex"],
		protectedBranch: remoteHead.ok || branch === "master" ? branch : "main",
		isGitRepo: git.ok,
	};
}

const q = (value: string) => JSON.stringify(value);
const list = (values: string[]) => `[${values.map(q).join(", ")}]`;

export const starterReviewGuide = `# Review guide

\`cagr review\` reads this file into every review. Say what matters in this repo and what does not.

## Always check

- Errors are handled where they happen, or passed up with context. Nothing fails silently.
- New behavior has a test that would fail if the code broke.
- Inputs from users, files and the network are checked before use.

## Important here

<!-- The places where a bug costs the most: money, auth, data loss, migrations. -->

## Skip

<!-- Generated code, vendored code, snapshots. Style is left to the linters. -->
`;

export function configToml(detection: Detection): string {
	const lines = [
		"# cagr config. `cagr doctor` checks it; `cagr sync` applies it.",
		'extends = ["recommended"]',
		"",
		"[agents]",
		`enabled = ${list(detection.agents)}`,
		"",
		"[git]",
		`protected_branch = ${q(detection.protectedBranch)}`,
		'branch_name = "type/name"',
		'commit_message = "conventional"',
	];
	const prePush = detection.stacks
		.map((stack) => stack.pre_push)
		.filter((command): command is string => command !== null);
	if (prePush.length > 0)
		lines.push(
			`pre_push = ${prePush.length === 1 ? q(prePush[0] as string) : list(prePush)}`,
		);
	for (const stack of detection.stacks) {
		lines.push("", "[[stack]]", `language = ${q(stack.language)}`);
		if (stack.package_manager)
			lines.push(`package_manager = ${q(stack.package_manager)}`);
		lines.push(
			`paths = ${list([stack.dir === "" ? "**" : `${stack.dir}/**`])}`,
		);
		lines.push(
			`on_edit = ${list(stack.on_edit)}`,
			`on_turn_end = ${list(stack.on_turn_end)}`,
		);
	}
	lines.push(
		"",
		"# Files agents may not edit, on top of the preset's .env* and lockfiles.",
		"# [[files.protected]]",
		'# glob = "migrations/**"',
		'# reason = "Migrations are generated. Run `bun run db:migrate` instead."',
		"",
		"# Commands agents may not run.",
		"# [[commands.blocked]]",
		'# match = "prisma db push"',
		'# reason = "Use `bun run db:migrate --name <change>`."',
		"",
		"# The preset gates `gh pr create` on a review by a reviewer agent and keeps merging with people.",
		"# REVIEW.md says what the reviewer should check. `cagr review help` shows the commands.",
		"# [review]",
		'# effort = "standard"   # quick, standard or deep; high-risk changes always get deep',
		'# skip = ["**/*.snap"]',
		"",
		"# Risk tiers by path: low needs no approval, medium one, high two. The change takes its highest file.",
		"# [[risk.paths]]",
		'# glob = "src/auth/**"',
		'# tier = "high"',
		'# owners = ["@your-org/security"]',
		'# reason = "Sign-in and sessions."',
		"",
		"# GitHub: `cagr sync` writes the workflow, the PR template and CODEOWNERS.",
		"# [ci]",
		"# github = true",
		"# review = true          # needs the ANTHROPIC_API_KEY secret",
		'# nightly = ["src/**"]',
		"",
	);
	return lines.join("\n");
}

/** Runs the repo's own on_edit commands on the files sync wrote, so the repo's lint passes on them. */
export async function formatGenerated(config: Config, written: string[]) {
	const files = written
		.filter((path) => path.endsWith(".json"))
		.map((path) => join(config.root, path));
	for (const stack of config.stack) {
		const paths = stackFiles(stack, files, config);
		if (paths.length === 0) continue;
		for (const command of stack.on_edit)
			await runShell(withFiles(command, paths), config.root, {
				timeoutMs: 30_000,
			});
	}
}

export type InitResult = {
	detection: Detection;
	config: string;
	written: string[];
	notes: string[];
};

export async function init(
	root: string,
	options: { dryRun?: boolean; force?: boolean } = {},
): Promise<InitResult> {
	const file = join(root, configFileName);
	if (existsSync(file) && !options.force)
		throw new Error(
			`${configFileName} already exists. Run \`cagr sync\` to rewrite the adapter files, or pass --force to start over.`,
		);
	const detection = await detect(root);
	const text = configToml(detection);
	const notes: string[] = [];
	if (options.dryRun) return { detection, config: text, written: [], notes };
	writeFileSync(file, text);
	const config = loadConfig(root);
	if (!config) throw new Error(`Could not read back ${file}.`);
	const synced = sync(config);
	const written = [configFileName, ...synced.written];
	notes.push(...keptNotes(synced.kept, synced.removed));
	const guide = join(root, config.review.guide);
	if (config.review.enabled && !existsSync(guide)) {
		writeFileSync(guide, starterReviewGuide);
		written.push(config.review.guide);
	}
	await formatGenerated(config, written);
	if (detection.isGitRepo) {
		await installGitHooks(config);
		notes.push(`Set git core.hooksPath to ${config.git.hooks_path}.`);
	} else
		notes.push(
			"Not a git repo, so the git hooks were written but core.hooksPath was not set. Run `cagr install-git-hooks` after `git init`.",
		);
	if (config.agents.enabled.includes("codex"))
		notes.push(
			"Codex asks you to trust project hooks. Open Codex in this repo and approve them with /hooks.",
		);
	return { detection, config: text, written: [...new Set(written)], notes };
}
