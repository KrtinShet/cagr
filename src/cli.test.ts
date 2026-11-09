import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkOptions } from "./cli";
import { starterFragments } from "./init";

const cli = join(import.meta.dir, "cli.ts");

test("--help on a command prints help and does not run it", () => {
	const dir = mkdtempSync(join(tmpdir(), "gw-cli-"));
	const result = Bun.spawnSync(["bun", cli, "init", "--help"], { cwd: dir });
	expect(result.exitCode).toBe(0);
	expect(result.stdout.toString()).toContain("Usage: cagr <command>");
	expect(existsSync(join(dir, "cagr.toml"))).toBe(false);
});

test("help names every .cagr file init writes, and the rules and review guide", () => {
	const result = Bun.spawnSync(["bun", cli, "help"]);
	const text = result.stdout.toString();
	for (const path of [
		"cagr.toml",
		...Object.keys(starterFragments),
		".cagr/rules/",
		".cagr/review.md",
	])
		expect(text).toContain(path);
});

test("an option a command does not take is an error that lists the ones it does", () => {
	expect(() => checkOptions("init", ["--dry"])).toThrow(
		"`cagr init` has no option --dry. It takes --dry-run, --force.",
	);
	expect(() => checkOptions("schema", ["-x"])).toThrow("It takes none.");
	expect(checkOptions("init", ["--dry-run", "--force"])).toBeNull();
	expect(checkOptions("risk", ["--base", "main", "src/a.ts"])).toBeNull();
	expect(checkOptions("hook", ["--anything"])).toBeNull();
});

test("explain, check and rules test know layout rules", async () => {
	const dir = mkdtempSync(join(tmpdir(), "gw-cli-"));
	await Bun.write(join(dir, "cagr.toml"), "");
	await Bun.write(
		join(dir, ".cagr/rules/layout.yml"),
		`id: kebab-files
message: Files use kebab-case names.
instead: Rename it, such as user-card.ts.
layout:
  files: ["src/**"]
  name: "^[a-z0-9]+(-[a-z0-9]+)*$"
examples:
  invalid: [src/UserCard.ts]
  valid: [src/user-card.ts]
`,
	);
	await Bun.write(join(dir, "src/UserCard.ts"), "export {};\n");
	const explain = Bun.spawnSync(["bun", cli, "explain", "kebab-files"], {
		cwd: dir,
	});
	expect(explain.stdout.toString()).toContain("kebab-files (layout rule from");
	const rulesTest = Bun.spawnSync(["bun", cli, "rules", "test"], { cwd: dir });
	expect(rulesTest.exitCode).toBe(0);
	expect(rulesTest.stdout.toString()).toContain(
		"1 rules, 2 examples, 0 failed.",
	);
	const check = Bun.spawnSync(["bun", cli, "check", "src/UserCard.ts"], {
		cwd: dir,
	});
	expect(check.exitCode).toBe(1);
	expect(check.stdout.toString() + check.stderr.toString()).toContain(
		"src/UserCard.ts kebab-files: Files use kebab-case names.",
	);
});

test("rules test fails a layout example that does not fire", async () => {
	const dir = mkdtempSync(join(tmpdir(), "gw-cli-"));
	await Bun.write(join(dir, "cagr.toml"), "");
	await Bun.write(
		join(dir, ".cagr/rules/layout.yml"),
		`id: kebab-files
message: Files use kebab-case names.
instead: Rename it, such as user-card.ts.
layout:
  files: ["src/**"]
  name: "^[a-z0-9]+(-[a-z0-9]+)*$"
examples:
  invalid: [lib/UserCard.ts]
  valid: [src/user-card.ts]
`,
	);
	const result = Bun.spawnSync(["bun", cli, "rules", "test"], { cwd: dir });
	expect(result.exitCode).toBe(1);
	expect(result.stdout.toString()).toContain(
		"FAIL kebab-files: invalid example did not fire:\n  lib/UserCard.ts",
	);
});
