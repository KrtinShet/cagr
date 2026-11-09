import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkOptions } from "./cli";

const cli = join(import.meta.dir, "cli.ts");

test("--help on a command prints help and does not run it", () => {
	const dir = mkdtempSync(join(tmpdir(), "gw-cli-"));
	const result = Bun.spawnSync(["bun", cli, "init", "--help"], { cwd: dir });
	expect(result.exitCode).toBe(0);
	expect(result.stdout.toString()).toContain("Usage: cagr <command>");
	expect(existsSync(join(dir, "cagr.toml"))).toBe(false);
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

test("explain and check know layout rules", async () => {
	const dir = mkdtempSync(join(tmpdir(), "gw-cli-"));
	await Bun.write(
		join(dir, "cagr.toml"),
		`[[layout]]
id = "kebab-files"
files = ["src/**"]
name = '^[a-z0-9]+(-[a-z0-9]+)*$'
message = "Files use kebab-case names."
instead = "Rename it, such as user-card.ts."
`,
	);
	await Bun.write(join(dir, "src/UserCard.ts"), "export {};\n");
	const explain = Bun.spawnSync(["bun", cli, "explain", "kebab-files"], {
		cwd: dir,
	});
	expect(explain.stdout.toString()).toContain("kebab-files (layout rule from");
	const check = Bun.spawnSync(["bun", cli, "check", "src/UserCard.ts"], {
		cwd: dir,
	});
	expect(check.exitCode).toBe(1);
	expect(check.stdout.toString() + check.stderr.toString()).toContain(
		"src/UserCard.ts kebab-files: Files use kebab-case names.",
	);
});
