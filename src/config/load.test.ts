import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig, merge, resolveConfig } from "./load";

const resolve = (raw: Record<string, unknown>) =>
	resolveConfig(raw, "/repo", "guardwright.toml");
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
	test("reads guardwright.toml from a parent folder", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gw-config-"));
		await writeFile(
			join(dir, "guardwright.toml"),
			'extends = ["recommended"]\n',
		);
		await mkdir(join(dir, "src/a"), { recursive: true });
		const config = loadConfig(join(dir, "src/a"));
		expect(config?.root).toBe(dir);
		expect(config?.git.protected_branch).toBe("main");
	});

	test("reads [tool.guardwright] from pyproject.toml", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gw-config-"));
		await writeFile(
			join(dir, "pyproject.toml"),
			'[project]\nname = "x"\n\n[tool.guardwright]\n[tool.guardwright.git]\nprotected_branch = "trunk"\n',
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
		await writeFile(
			join(dir, "guardwright.toml"),
			"[git]\nprotected_branch = \n",
		);
		expect(() => loadConfig(dir)).toThrow(
			/guardwright\.toml:\d+:\d+: not valid TOML/,
		);
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
			command: "guardwright",
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
