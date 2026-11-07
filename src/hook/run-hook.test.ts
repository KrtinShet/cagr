import { expect, test } from "bun:test";
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
			throw new ConfigError("guardwright.toml:3:1: not valid TOML");
		},
	);
	expect(JSON.parse(output)).toEqual({
		systemMessage:
			"guardwright is off for this call because of an error. guardwright.toml:3:1: not valid TOML",
	});
});

test("bad JSON on stdin also fails open", async () => {
	expect(
		JSON.parse(
			await runHook("claude", "command.before", "{", "/repo", () => null),
		).systemMessage,
	).toContain("off for this call");
});

test("no config means guardwright stays out of the way", async () => {
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
