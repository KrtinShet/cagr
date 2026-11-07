import { describe, expect, test } from "bun:test";
import { parseInput, renderDecision } from "./adapters";

describe("parseInput", () => {
	test("reads a Claude Code Bash call", () => {
		expect(
			parseInput(
				"claude",
				"command.before",
				{
					session_id: "s1",
					cwd: "/repo",
					tool_name: "Bash",
					tool_input: { command: "npm i" },
				},
				"/x",
			),
		).toEqual({
			event: "command.before",
			sessionId: "s1",
			cwd: "/repo",
			command: "npm i",
			files: [],
		});
	});

	test("reads a Codex command sent as argv", () => {
		const input = (command: unknown) =>
			parseInput(
				"codex",
				"command.before",
				{ tool_input: { command } },
				"/repo",
			);
		expect(input(["bash", "-lc", "npm i && ls"]).command).toBe("npm i && ls");
		expect(input(["/bin/zsh", "-c", "pip install x"]).command).toBe(
			"pip install x",
		);
		expect(input(["git", "commit", "-m", "a b"]).command).toBe(
			"git commit -m 'a b'",
		);
		expect(input([1, 2]).command).toBeNull();
	});

	test("reads edited files, relative to cwd, from Claude and from an apply_patch body", () => {
		expect(
			parseInput(
				"claude",
				"file.before_edit",
				{ cwd: "/repo", tool_input: { file_path: "src/a.ts" } },
				"/x",
			).files,
		).toEqual(["/repo/src/a.ts"]);
		const patch =
			"*** Begin Patch\n*** Update File: src/b.py\n@@\n-a\n+b\n*** Add File: .env\n+X=1\n*** End Patch\n";
		expect(
			parseInput(
				"codex",
				"file.after_edit",
				{ cwd: "/repo", tool_input: { command: patch } },
				"/x",
			).files,
		).toEqual(["/repo/src/b.py", "/repo/.env"]);
	});

	test("falls back to the process folder and an unknown session", () => {
		expect(parseInput("claude", "turn.end", {}, "/here")).toMatchObject({
			cwd: "/here",
			sessionId: "unknown",
		});
	});
});

describe("renderDecision", () => {
	test("deny uses PreToolUse permissionDecision", () => {
		expect(
			JSON.parse(
				renderDecision("claude", "command.before", {
					kind: "deny",
					reason: "no",
				}),
			),
		).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: "no",
			},
		});
	});

	test("block uses decision and reason, with a notice for the human", () => {
		expect(
			JSON.parse(
				renderDecision("codex", "turn.end", {
					kind: "block",
					reason: "fix",
					notice: "hi",
				}),
			),
		).toEqual({
			decision: "block",
			reason: "fix",
			systemMessage: "hi",
		});
	});

	test("session context is plain text; a notice is a systemMessage; a plain allow prints nothing", () => {
		expect(
			renderDecision("claude", "session.start", {
				kind: "allow",
				context: "brief",
			}),
		).toBe("brief");
		expect(
			JSON.parse(
				renderDecision("codex", "turn.end", {
					kind: "allow",
					notice: "gave up",
				}),
			),
		).toEqual({ systemMessage: "gave up" });
		expect(renderDecision("claude", "file.after_edit", { kind: "allow" })).toBe(
			"",
		);
	});

	test("long text is cut under the agents' 10,000 character cap", () => {
		const out = JSON.parse(
			renderDecision("claude", "turn.end", {
				kind: "block",
				reason: "x".repeat(20_000),
			}),
		);
		expect(out.reason.length).toBeLessThan(10_000);
	});
});
