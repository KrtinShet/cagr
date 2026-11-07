import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../config/load";
import { readTurnState, stateFile } from "../turn-state";
import { handle } from "./handlers";
import type { HookInput } from "./types";

let root: string;
let session: string;
const config = () =>
	resolveConfig(
		{
			extends: ["recommended"],
			stack: [
				{
					language: "typescript",
					package_manager: "bun",
					paths: ["src/**"],
					on_edit: ["! grep -n BAD {files}"],
					on_turn_end: ["! grep -n TODO {files}"],
				},
			],
			commands: {
				blocked: [
					{ match: "prisma db push", reason: "Use `bun run db:migrate`." },
				],
			},
		},
		root,
		join(root, "guardwright.toml"),
	);
const input = (
	event: HookInput["event"],
	extra: Partial<HookInput> = {},
): HookInput => ({
	event,
	sessionId: session,
	cwd: root,
	command: null,
	files: [],
	...extra,
});
const write = async (path: string, text: string) => {
	await writeFile(join(root, path), text);
	return join(root, path);
};

beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), "gw-handlers-")));
	await mkdir(join(root, "src"));
	session = `test-${crypto.randomUUID()}`;
});

describe("command.before", () => {
	test("denies another package manager with the fix", async () => {
		const decision = await handle(
			input("command.before", { command: "npm install zod" }),
			config(),
		);
		expect(decision).toEqual({
			kind: "deny",
			reason:
				"This repo uses bun for JavaScript. Use bun or bunx instead of npm, npx, pnpm, pnpx, or yarn. (guardwright: package-manager)",
		});
	});

	test("denies a blocked command and a push to the protected branch", async () => {
		expect(
			await handle(
				input("command.before", { command: "bunx prisma db push" }),
				config(),
			),
		).toMatchObject({
			kind: "deny",
			reason: expect.stringContaining("(guardwright: blocked-command)"),
		});
		expect(
			await handle(
				input("command.before", { command: "git push origin main" }),
				config(),
			),
		).toMatchObject({
			kind: "deny",
			reason: expect.stringContaining("(guardwright: protected-branch)"),
		});
	});

	test("allows ordinary commands", async () => {
		expect(
			await handle(
				input("command.before", { command: "bun add zod && git status" }),
				config(),
			),
		).toEqual({ kind: "allow" });
	});
});

describe("file.before_edit", () => {
	test("denies a protected file and allows its exception", async () => {
		expect(
			await handle(
				input("file.before_edit", { files: [join(root, ".env")] }),
				config(),
			),
		).toMatchObject({
			kind: "deny",
			reason: expect.stringContaining("tell the user which key is missing"),
		});
		expect(
			await handle(
				input("file.before_edit", { files: [join(root, ".env.example")] }),
				config(),
			),
		).toEqual({ kind: "allow" });
	});
});

describe("file.after_edit", () => {
	test("blocks with the check's output and records the edit", async () => {
		const file = await write("src/a.ts", "const x = 1;\nBAD\n");
		const decision = await handle(
			input("file.after_edit", { files: [file] }),
			config(),
		);
		expect(decision.kind).toBe("block");
		expect(decision.kind === "block" && decision.reason).toContain(
			"## ! grep -n BAD {files}\n2:BAD",
		);
		expect((await readTurnState(stateFile(session))).files).toEqual([file]);
	});

	test("allows a clean edit and skips files no stack covers", async () => {
		const clean = await write("src/b.ts", "ok\n");
		const outside = await write("notes.ts", "BAD\n");
		expect(
			await handle(
				input("file.after_edit", { files: [clean, outside] }),
				config(),
			),
		).toEqual({ kind: "allow" });
	});
});

describe("turn.end", () => {
	test("allows a turn with no edits", async () => {
		expect(await handle(input("turn.end"), config())).toEqual({
			kind: "allow",
		});
	});

	test("blocks until the check passes, then clears the turn", async () => {
		const file = await write("src/a.ts", "// TODO\n");
		await handle(input("file.after_edit", { files: [file] }), config());
		const blocked = await handle(input("turn.end"), config());
		expect(blocked.kind === "block" && blocked.reason).toContain(
			"You changed code this turn and `! grep -n TODO {files}` failed",
		);
		expect((await readTurnState(stateFile(session))).failedStops).toBe(1);
		await write("src/a.ts", "// done\n");
		expect(await handle(input("turn.end"), config())).toEqual({
			kind: "allow",
		});
		expect(await readTurnState(stateFile(session))).toEqual({
			files: [],
			failedStops: 0,
		});
	});

	test("lets the agent go after three blocked stops and tells the human", async () => {
		const file = await write("src/a.ts", "// TODO\n");
		await handle(input("file.after_edit", { files: [file] }), config());
		expect((await handle(input("turn.end"), config())).kind).toBe("block");
		expect((await handle(input("turn.end"), config())).kind).toBe("block");
		const third = await handle(input("turn.end"), config());
		expect(third).toEqual({
			kind: "allow",
			notice: expect.stringContaining(
				"still failing after 3 attempts. The agent was let go",
			),
		});
		expect((await readTurnState(stateFile(session))).files).toEqual([]);
	});
});

test("session.start returns the brief", async () => {
	const decision = await handle(input("session.start"), config());
	expect(decision.kind === "allow" && decision.context).toContain(
		"Package managers: bun for JavaScript.",
	);
});
