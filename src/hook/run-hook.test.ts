import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "../config/load";
import { config } from "../test/config";
import { runHook } from "./run-hook";

const bashCall = JSON.stringify({
	session_id: "s",
	cwd: "/repo",
	tool_input: { command: "npm i" },
});

test("a config error lets the call through and tells the human", async () => {
	const output = await runHook(
		"claude",
		"command.before",
		bashCall,
		"/repo",
		() => {
			throw new ConfigError("cagr.toml:3:1: not valid TOML");
		},
	);
	expect(JSON.parse(output)).toEqual({
		systemMessage:
			"cagr is off for this call because of an error. cagr.toml:3:1: not valid TOML",
	});
});

test("bad JSON on stdin also fails open", async () => {
	expect(
		JSON.parse(
			await runHook("claude", "command.before", "{", "/repo", () => null),
		).systemMessage,
	).toContain("off for this call");
});

test("no config means cagr stays out of the way", async () => {
	expect(
		await runHook("claude", "command.before", bashCall, "/repo", () => null),
	).toBe("");
});

test("a found config is enforced", async () => {
	const repo = config({
		stack: [{ language: "typescript", package_manager: "bun" }],
	});
	const output = JSON.parse(
		await runHook("codex", "command.before", bashCall, "/repo", () => repo),
	);
	expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
});

test("no environment variable turns the hooks off", async () => {
	process.env.CAGR_REVIEWER = "1";
	try {
		expect(
			await runHook("claude", "command.before", bashCall, "/repo", () =>
				config({ stack: [{ language: "typescript", package_manager: "bun" }] }),
			),
		).toContain('"deny"');
	} finally {
		delete process.env.CAGR_REVIEWER;
	}
});

test("a protected glob from a .cagr/ fragment denies the edit", async () => {
	const dir = await mkdtemp(join(tmpdir(), "gw-fragment-hook-"));
	await mkdir(join(dir, ".cagr"), { recursive: true });
	await writeFile(join(dir, "cagr.toml"), "");
	await writeFile(
		join(dir, ".cagr/guards.toml"),
		'[[files.protected]]\nglob = "infra/**"\nreason = "Infra changes go through the platform team."\n',
	);
	const output = await runHook(
		"claude",
		"file.before_edit",
		JSON.stringify({
			session_id: "s",
			cwd: dir,
			tool_name: "Write",
			tool_input: { file_path: join(dir, "infra/main.tf"), content: "" },
		}),
		dir,
	);
	expect(output).toContain("Infra changes go through the platform team.");
});

test("a suppression git error fails open and tells the human", async () => {
	const dir = await mkdtemp(join(tmpdir(), "gw-suppression-error-"));
	await writeFile(join(dir, "cagr.toml"), 'extends = ["recommended"]\n');
	const file = join(dir, "a.ts");
	await writeFile(file, "// @ts-ignore\n");
	const output = JSON.parse(
		await runHook(
			"claude",
			"file.after_edit",
			JSON.stringify({
				session_id: "suppression-error",
				cwd: dir,
				tool_name: "Write",
				tool_input: { file_path: file },
			}),
			dir,
		),
	);
	expect(output.systemMessage).toContain(
		"off for this call because of an error",
	);
	expect(output.decision).toBeUndefined();
});
