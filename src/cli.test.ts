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
	expect(result.stdout.toString()).toContain("Usage: guardwright <command>");
	expect(existsSync(join(dir, "guardwright.toml"))).toBe(false);
});

test("an option a command does not take is an error that lists the ones it does", () => {
	expect(() => checkOptions("init", ["--dry"])).toThrow(
		"`guardwright init` has no option --dry. It takes --dry-run, --force.",
	);
	expect(() => checkOptions("schema", ["-x"])).toThrow("It takes none.");
	expect(checkOptions("init", ["--dry-run", "--force"])).toBeNull();
	expect(checkOptions("risk", ["--base", "main", "src/a.ts"])).toBeNull();
	expect(checkOptions("hook", ["--anything"])).toBeNull();
});
