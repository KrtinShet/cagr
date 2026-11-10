import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig, merge, resolveConfig } from "./load";

const resolve = (raw: Record<string, unknown>) =>
	resolveConfig(raw, "/repo", "cagr.toml");
const problems = (raw: Record<string, unknown>) => {
	try {
		resolve(raw);
		return "";
	} catch (error) {
		expect(error).toBeInstanceOf(ConfigError);
		return (error as Error).message;
	}
};

describe("finding the config", () => {
	test("reads cagr.toml from a parent folder", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gw-config-"));
		await writeFile(join(dir, "cagr.toml"), 'extends = ["recommended"]\n');
		await mkdir(join(dir, "src/a"), { recursive: true });
		const config = loadConfig(join(dir, "src/a"));
		expect(config?.root).toBe(dir);
		expect(config?.git.protected_branch).toBe("main");
	});

	test("reads [tool.cagr] from pyproject.toml", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gw-config-"));
		await writeFile(
			join(dir, "pyproject.toml"),
			'[project]\nname = "x"\n\n[tool.cagr]\n[tool.cagr.git]\nprotected_branch = "trunk"\n',
		);
		expect(loadConfig(dir)?.git.protected_branch).toBe("trunk");
	});

	test("skips a pyproject.toml without the table", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gw-config-"));
		await writeFile(join(dir, "pyproject.toml"), '[project]\nname = "x"\n');
		expect(loadConfig(dir)).toBeNull();
	});

	test("reports bad TOML with its line", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gw-config-"));
		await writeFile(join(dir, "cagr.toml"), "[git]\nprotected_branch = \n");
		expect(() => loadConfig(dir)).toThrow(/cagr\.toml:\d+:\d+: not valid TOML/);
	});
});

describe("validation names the key and the fix", () => {
	test("a typo gets a suggestion", () => {
		expect(problems({ git: { protected_brnch: "main" } })).toContain(
			"git.protected_brnch is not a known key. Did you mean protected_branch?",
		);
	});

	test("a wrong type", () => {
		expect(
			problems({ stack: [{ language: "python", on_edit: "ruff" }] }),
		).toContain("stack[0].on_edit must be a list, not a string.");
	});

	test("a missing required key", () => {
		expect(problems({ commands: { blocked: [{ match: "x" }] } })).toContain(
			"commands.blocked[0].reason is required.",
		);
	});

	test("an unknown package manager lists the choices", () => {
		expect(
			problems({ stack: [{ language: "python", package_manager: "conda" }] }),
		).toContain('stack[0].package_manager is "conda". Use one of:');
	});

	test("an unknown preset", () => {
		expect(problems({ extends: ["strict"] })).toContain(
			'extends names "strict", which is not a known preset',
		);
	});

	test("name rules", () => {
		expect(problems({ git: { commit_message: "angular" } })).toContain(
			'git.commit_message must be "conventional", "off"',
		);
		expect(
			problems({ git: { branch_name: { pattern: "(", example: "x" } } }),
		).toContain("not a valid regular expression");
	});
});

describe("presets", () => {
	test("lists of tables add to the preset", () => {
		const config = resolve({
			extends: ["recommended"],
			files: { protected: [{ glob: "secrets/**", reason: "No." }] },
		});
		expect(config.files.protected.map((entry) => entry.glob)).toEqual([
			"biome.json",
			"biome.jsonc",
			"eslint.config.*",
			".eslintrc*",
			"ruff.toml",
			".ruff.toml",
			"mypy.ini",
			".golangci.y*ml",
			"clippy.toml",
			".oxlintrc.json",
			".env*",
			expect.stringContaining("bun.lock"),
			"secrets/**",
		]);
	});

	test("other values replace the preset's", () => {
		const config = resolve({
			extends: ["recommended"],
			git: { protected_branch: "trunk", commit_message: "off" },
		});
		expect(config.git.protected_branch).toBe("trunk");
		expect(config.git.commit_message).toBeNull();
		expect(config.git.block_force_push).toBe(true);
	});

	test("a custom resolver plugs in, and loops are caught", () => {
		const loop = (name: string) =>
			name === "a" ? { extends: ["a"] } : undefined;
		expect(() => resolveConfig({ extends: ["a"] }, "/r", "x", [loop])).toThrow(
			"loops",
		);
	});

	test("merge keeps plain lists whole", () => {
		expect(merge({ a: ["x"], b: { c: 1 } }, { a: ["y"], b: { d: 2 } })).toEqual(
			{
				a: ["y"],
				b: { c: 1, d: 2 },
			},
		);
	});
});

describe("defaults", () => {
	test("an empty config guards nothing", () => {
		const config = resolve({});
		expect(config.git.protected_branch).toBeNull();
		expect(config.git.block_force_push).toBe(false);
		expect(config.files.protected).toEqual([]);
		expect(config.agents).toEqual({
			enabled: ["claude", "codex"],
			command: "cagr",
			nested_docs: false,
		});
	});

	test("a stack gets its language's extensions and every path", () => {
		const [stack] = resolve({ stack: [{ language: "python" }] }).stack;
		expect(stack?.extensions).toEqual(["py", "pyi"]);
		expect(stack?.paths).toEqual(["**"]);
	});

	test("pre_push takes one command or a list", () => {
		expect(
			resolve({ git: { pre_push: "bun run verify" } }).git.pre_push,
		).toEqual(["bun run verify"]);
		expect(resolve({ git: { pre_push: ["a", "b"] } }).git.pre_push).toEqual([
			"a",
			"b",
		]);
	});

	test("the example config from the README loads", async () => {
		const text = await Bun.file(
			join(import.meta.dir, "../../README.md"),
		).text();
		const toml = text.match(/```toml\n([\s\S]*?)```/)?.[1] ?? "";
		const config = resolve(Bun.TOML.parse(toml) as Record<string, unknown>);
		expect(config.stack.map((stack) => stack.language)).toEqual([
			"typescript",
			"python",
		]);
	});
});

describe("fragments in .cagr/", () => {
	test("a table in one file and a plain value in another clash", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gw-fragments-"));
		await mkdir(join(dir, ".cagr"), { recursive: true });
		await writeFile(
			join(dir, "cagr.toml"),
			'[git]\nbranch_name = "type/name"\n',
		);
		await writeFile(
			join(dir, ".cagr/git.toml"),
			'[git.branch_name]\npattern = "^x/.+$"\nexample = "x/y"\n',
		);
		expect(() => loadConfig(dir)).toThrow(
			`git.branch_name is set in both ${join(dir, "cagr.toml")} and ${join(dir, ".cagr/git.toml")}.`,
		);
		await writeFile(
			join(dir, "cagr.toml"),
			'[git]\nbranch_name = { pattern = "^x/.+$", example = "x/y" }\n',
		);
		await writeFile(
			join(dir, ".cagr/git.toml"),
			'[git]\nbranch_name = "type/name"\n',
		);
		expect(() => loadConfig(dir)).toThrow("git.branch_name is set in both");
	});

	test("an empty list of guards adds nothing and removes nothing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gw-fragments-"));
		await mkdir(join(dir, ".cagr"), { recursive: true });
		await writeFile(
			join(dir, "cagr.toml"),
			'extends = ["recommended"]\nfiles.protected = []\n[[commands.blocked]]\nmatch = "db push"\nreason = "Migrate."\n',
		);
		await writeFile(
			join(dir, ".cagr/a.toml"),
			"commands.blocked = []\nfiles.protected = []\n",
		);
		const config = loadConfig(dir);
		expect(config?.commands.blocked.map((entry) => entry.match)).toEqual([
			"db push",
		]);
		expect(config?.files.protected.map((entry) => entry.glob)).toContain(
			".env*",
		);
	});

	test("review eval cases in .cagr/review-evals are not config", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gw-fragments-"));
		await mkdir(join(dir, ".cagr/review-evals"), { recursive: true });
		await writeFile(join(dir, "cagr.toml"), "");
		await writeFile(
			join(dir, ".cagr/review-evals/null-check.toml"),
			'base = "abc"\nhead = "def"\nclean = true\n',
		);
		expect(loadConfig(dir)?.sources).toEqual([join(dir, "cagr.toml")]);
	});

	async function repo(files: Record<string, string>) {
		const dir = await mkdtemp(join(tmpdir(), "gw-fragments-"));
		for (const [path, text] of Object.entries(files)) {
			await mkdir(join(dir, path, ".."), { recursive: true });
			await writeFile(join(dir, path), text);
		}
		return dir;
	}

	test("every .cagr/**/*.toml joins cagr.toml, and lists of tables add up", async () => {
		const dir = await repo({
			"cagr.toml":
				'extends = ["recommended"]\n[[files.protected]]\nglob = "a/**"\nreason = "A."\n',
			".cagr/guards.toml":
				'[[files.protected]]\nglob = "b/**"\nreason = "B."\n\n[[commands.blocked]]\nmatch = "db push"\nreason = "Migrate."\n',
			".cagr/team/risk.toml":
				'[[risk.paths]]\nglob = "src/auth/**"\ntier = "high"\n\n[review]\neffort = "deep"\n',
			".cagr/rules/r.yml": "not: toml\n",
		});
		const config = loadConfig(dir);
		expect(config?.files.protected.map((entry) => entry.glob)).toEqual([
			"biome.json",
			"biome.jsonc",
			"eslint.config.*",
			".eslintrc*",
			"ruff.toml",
			".ruff.toml",
			"mypy.ini",
			".golangci.y*ml",
			"clippy.toml",
			".oxlintrc.json",
			".env*",
			expect.stringContaining("bun.lock"),
			"a/**",
			"b/**",
		]);
		expect(config?.commands.blocked.map((entry) => entry.match)).toEqual([
			"db push",
		]);
		expect(config?.risk.paths.map((entry) => entry.glob)).toContain(
			"src/auth/**",
		);
		expect(config?.review.effort).toBe("deep");
		expect(config?.review.enabled).toBe(true);
		expect(config?.sources).toEqual([
			join(dir, "cagr.toml"),
			join(dir, ".cagr/guards.toml"),
			join(dir, ".cagr/team/risk.toml"),
		]);
	});

	test("a value set in two files is an error that names both", async () => {
		const dir = await repo({
			"cagr.toml": '[review]\neffort = "quick"\n',
			".cagr/a.toml": '[git]\npre_push = ["x"]\n',
			".cagr/b.toml": '[review]\neffort = "deep"\n[git]\npre_push = ["y"]\n',
		});
		const message = (() => {
			try {
				loadConfig(dir);
				return "";
			} catch (error) {
				expect(error).toBeInstanceOf(ConfigError);
				return (error as Error).message;
			}
		})();
		expect(message).toContain(
			`review.effort is set in both ${join(dir, "cagr.toml")} and ${join(dir, ".cagr/b.toml")}. Keep it in one of them.`,
		);
		expect(message).toContain(
			`git.pre_push is set in both ${join(dir, ".cagr/a.toml")} and ${join(dir, ".cagr/b.toml")}.`,
		);
	});

	test("a fragment is checked against the same schema, and the error names it", async () => {
		const dir = await repo({
			"cagr.toml": "",
			".cagr/guards.toml": '[[commands.blocked]]\nmatch = "x"\n',
		});
		expect(() => loadConfig(dir)).toThrow(
			`${join(dir, ".cagr/guards.toml")} has problems:\n  - commands.blocked[0].reason is required.`,
		);
		await writeFile(
			join(dir, ".cagr/guards.toml"),
			"[git]\nprotected_branch = \n",
		);
		expect(() => loadConfig(dir)).toThrow(
			new RegExp(`${join(dir, ".cagr/guards.toml")}:\\d+:\\d+: not valid TOML`),
		);
	});

	test("extends stays in cagr.toml; $schema may be in every file", async () => {
		const dir = await repo({
			"cagr.toml": '"$schema" = "./cagr.schema.json"\n',
			".cagr/a.toml": '"$schema" = "../cagr.schema.json"\n',
		});
		expect(loadConfig(dir)?.sources).toHaveLength(2);
		await writeFile(join(dir, ".cagr/a.toml"), 'extends = ["recommended"]\n');
		expect(() => loadConfig(dir)).toThrow(
			"sets extends. Presets are chosen in",
		);
	});

	test("the review guide is .cagr/review.md, or REVIEW.md when only that exists", async () => {
		const none = await repo({ "cagr.toml": "" });
		expect(loadConfig(none)?.review.guide).toBe(".cagr/review.md");
		const old = await repo({ "cagr.toml": "", "REVIEW.md": "x" });
		expect(loadConfig(old)?.review.guide).toBe("REVIEW.md");
		const both = await repo({
			"cagr.toml": "",
			"REVIEW.md": "x",
			".cagr/review.md": "y",
		});
		expect(loadConfig(both)?.review.guide).toBe(".cagr/review.md");
		const set = await repo({
			"cagr.toml": '[review]\nguide = "docs/review.md"\n',
			".cagr/review.md": "y",
		});
		expect(loadConfig(set)?.review.guide).toBe("docs/review.md");
	});
});
