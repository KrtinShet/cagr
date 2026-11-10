import { afterEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../config/load";
import { stateFile } from "../turn-state";
import { runHook } from "./run-hook";
import {
	aggregateStats,
	commandId,
	commandTarget,
	readStats,
	recordStats,
	retryHint,
	type StatEvent,
	statsFile,
	statsReport,
	statsSummary,
} from "./stats";

const roots: string[] = [];
function repo(raw = {}) {
	const root = mkdtempSync(join(tmpdir(), "cagr-stats-test-"));
	roots.push(root);
	return resolveConfig(raw, root, "test.toml");
}
afterEach(() => {
	for (const root of roots.splice(0)) {
		for (const suffix of ["", ".1", ".lock", ".repeat", ".repeat.1"])
			rmSync(statsFile(root) + suffix, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	}
});

test("records outcomes, isolates repeats by session, target and id, and skips plain allows", async () => {
	const config = repo({
		stack: [{ language: "typescript", package_manager: "bun" }],
	});
	const call = (command: string, session = "one") =>
		runHook(
			"claude",
			"command.before",
			JSON.stringify({
				session_id: session,
				cwd: config.root,
				tool_input: { command },
			}),
			config.root,
			() => config,
		);
	await runHook(
		"claude",
		"session.start",
		JSON.stringify({ session_id: "quiet", cwd: config.root }),
		config.root,
		() => config,
	);
	expect(await call("bun test")).toBe("");
	for (const session of ["one", "one", "two"])
		expect(await call("npm install secret", session)).toContain('"deny"');
	await call("npm install different", "one");
	const entries = readStats(config.root);
	expect(entries.map((e) => e.repeat)).toEqual([
		false,
		false,
		true,
		false,
		false,
	]);
	expect(entries[1]).toMatchObject({
		id: "package-manager",
		decision: "deny",
		target: "npm install",
		agent: "claude",
		event: "command.before",
	});
	expect(readFileSync(statsFile(config.root), "utf8")).not.toContain("secret");
	expect(aggregateStats(entries, []).sessions).toBe(3);
});

test("redacts arguments, assignments, shell expansion and unknown second words", () => {
	for (const [raw, want] of [
		["git push origin token", "git push"],
		["curl SECRET", "curl"],
		["TOKEN=secret bun run test", "command"],
		["echo $(secret)", "echo"],
		["/bin/git push --secret", "git push"],
		["bun run private-script", "bun run"],
	])
		expect(commandTarget(raw ?? "")).toBe(want ?? "");
	expect(commandId("on_edit", "bun run lint")).not.toBe(
		commandId("on_edit", "bun run types"),
	);
	expect(commandId("on_edit", "bun run SECRET")).not.toContain("SECRET");
});

test("edit commands block and the third failing stop escapes with rule attribution", async () => {
	const config = repo({
		stack: [
			{
				language: "typescript",
				paths: ["**"],
				on_edit: ["exit 1"],
				on_turn_end: ["exit 1"],
			},
		],
	});
	const file = join(config.root, "a.ts");
	writeFileSync(file, "const a = 1;");
	const session = crypto.randomUUID();
	await runHook(
		"claude",
		"file.after_edit",
		JSON.stringify({
			session_id: session,
			cwd: config.root,
			tool_input: { file_path: file },
		}),
		config.root,
		() => config,
	);
	for (let i = 0; i < 3; i++)
		await runHook(
			"claude",
			"turn.end",
			JSON.stringify({ session_id: session, cwd: config.root }),
			config.root,
			() => config,
		);
	const entries = readStats(config.root);
	expect(
		entries.filter((e) => e.id === commandId("on_edit", "exit 1"))[0]?.decision,
	).toBe("block");
	expect(
		entries
			.filter((e) => e.id === commandId("on_turn_end", "exit 1"))
			.map((e) => e.decision),
	).toEqual(["block", "block", "stop-escape"]);
	expect(
		entries.some((e) => e.id === "stop-escape" && e.decision === "stop-escape"),
	).toBe(true);
	rmSync(stateFile(session), { force: true });
});

test("fail-open errors are counted and recording failure leaves hook output alone", async () => {
	const config = repo({
		stack: [{ language: "typescript", package_manager: "bun" }],
	});
	const payload = JSON.stringify({
		session_id: "s",
		cwd: config.root,
		tool_input: { command: "npm install" },
	});
	const normal = await runHook(
		"claude",
		"command.before",
		payload,
		config.root,
		() => config,
	);
	rmSync(statsFile(config.root));
	mkdirSync(statsFile(config.root));
	expect(
		await runHook(
			"claude",
			"command.before",
			payload,
			config.root,
			() => config,
		),
	).toBe(normal);
	rmSync(statsFile(config.root), { recursive: true });
	expect(
		await runHook("claude", "command.before", payload, config.root, () => {
			throw Error("private detail");
		}),
	).toContain("off for this call");
	expect(readStats(config.root)[0]?.decision).toBe("fail-open");
	expect(readFileSync(statsFile(config.root), "utf8")).not.toContain(
		"private detail",
	);
});

test("off switch defaults on and prevents all writes including fail-open", async () => {
	expect(repo().stats.enabled).toBe(true);
	const config = repo({
		stats: { enabled: false },
		stack: [{ language: "typescript", package_manager: "bun" }],
	});
	await runHook(
		"claude",
		"command.before",
		JSON.stringify({ cwd: config.root, tool_input: { command: "npm i" } }),
		config.root,
		() => config,
	);
	expect(readStats(config.root)).toEqual([]);
});

test("aggregation filters days, sorts counts, reports shares, never-fired and repeat hints", () => {
	const now = Date.now();
	const time = new Date(now).toISOString();
	const entry: StatEvent = {
		id: "guard",
		decision: "block",
		target: "a",
		time,
		event: "file.after_edit",
		agent: "claude",
		session: "s",
		repeat: false,
	};
	const result = aggregateStats(
		[
			entry,
			{ ...entry, repeat: true },
			{ ...entry, repeat: true },
			{ ...entry, id: "session", decision: "session", session: "quiet" },
			{ ...entry, id: "old", time: new Date(now - 8 * 86400000).toISOString() },
		],
		["guard", "unused"],
		7,
		now,
	);
	expect(result.rows[0]).toMatchObject({
		count: 3,
		counts: { block: 3 },
		repeats: 2,
		lastSeen: time,
		sessionShare: 0.5,
		hint: retryHint,
	});
	expect(result.rows[1]?.hint).toBe("never fired in this window");
	expect(statsReport(result)).toContain("sessions 50%");
	const config = repo();
	recordStats(config.root, "command.before", "claude", "s", [
		{ id: "guard", decision: "deny", target: "git push" },
	]);
	expect(statsSummary(config.root)).toBe(
		"Blocks: 1 in 7 days, top: guard 1. Run `cagr stats`.",
	);
});

test("bounded append storage rotates, tolerates broken lines, and stays under recording budget", () => {
	const config = repo();
	const event = { id: "guard", decision: "block" as const, target: "a" };
	for (let i = 0; i < 6500; i++)
		recordStats(config.root, "file.after_edit", "claude", `${i}`, [event]);
	expect(statSync(statsFile(config.root)).size).toBeLessThanOrEqual(512000);
	expect(statSync(`${statsFile(config.root)}.1`).size).toBeLessThanOrEqual(
		512000,
	);
	const times: number[] = [];
	for (let i = 0; i < 30; i++) {
		const start = performance.now();
		recordStats(config.root, "file.after_edit", "claude", "last", [event]);
		times.push(performance.now() - start);
	}
	times.sort((a, b) => a - b);
	expect(times[27] ?? Infinity).toBeLessThan(5);
	expect(readStats(config.root).length).toBeLessThan(6500);
	expect(statSync(`${statsFile(config.root)}.repeat`).size).toBeLessThanOrEqual(
		20_000,
	);
	expect(
		statSync(`${statsFile(config.root)}.repeat.1`).size,
	).toBeLessThanOrEqual(20_000);
	writeFileSync(statsFile(config.root), "broken\n{}");
	expect(() => readStats(config.root)).not.toThrow();
});

test("code, layout, suppression and change decisions keep their own ids", async () => {
	const { tempRepo } = await import("../test/repo");
	const { root, write } = await tempRepo("cagr-stats-rules-");
	roots.push(root);
	await write(
		".cagr/rules/test.yml",
		`id: no-console
language: typescript
message: Debug output.
instead: Use the logger.
rule:
  pattern: console.log($$$A)
examples:
  invalid: ["console.log(1)"]
  valid: ["log(1)"]
---
id: kebab
message: Use lowercase names.
instead: Rename the file to lowercase.
layout:
  files: ["*.ts"]
  name: "^[a-z]+$"
examples:
  invalid: [Bad.ts]
  valid: [good.ts]
`,
	);
	const config = resolveConfig(
		{
			suppressions: { enabled: true },
			changes: {
				rules: [
					{
						id: "keep-readme",
						kind: "add_only",
						paths: ["README.md"],
						reason: "Add a new document instead.",
						examples: {
							valid: [{ changes: [{ path: "README.md", status: "A" }] }],
							invalid: [{ changes: [{ path: "README.md", status: "M" }] }],
						},
					},
				],
			},
		},
		root,
		"test.toml",
	);
	const session = crypto.randomUUID();
	const call = (
		event: "file.before_edit" | "file.after_edit" | "turn.end",
		file = join(root, "Bad.ts"),
	) =>
		runHook(
			"claude",
			event,
			JSON.stringify({
				session_id: session,
				cwd: root,
				tool_input: { file_path: file },
			}),
			root,
			() => config,
		);
	expect(await call("file.before_edit")).toContain('"deny"');
	await write("Bad.ts", "// @ts-ignore\nconsole.log(1);\nconsole.log(2);\n");
	expect(await call("file.after_edit")).toContain('"block"');
	await write("README.md", "changed\n");
	expect(await call("turn.end")).toContain('"block"');
	const events = readStats(root);
	for (const id of ["no-console", "kebab", "lint-suppression", "keep-readme"])
		expect(events.some((e) => e.id === id)).toBe(true);
	expect(
		events.filter(
			(e) => e.id === "no-console" && e.event === "file.after_edit",
		),
	).toHaveLength(1);
	rmSync(stateFile(session), { force: true });
});

test("repeat lookup ignores forged or broken event lines and requires exact fixed-width keys", () => {
	const config = repo();
	const entry = { id: "guard", decision: "deny" as const, target: "git push" };
	recordStats(config.root, "command.before", "claude", "s", [entry]);
	const key = readStats(config.root)[0]?.key;
	rmSync(`${statsFile(config.root)}.repeat`);
	writeFileSync(statsFile(config.root), `not-json "key":"${key}"\n`);
	recordStats(config.root, "command.before", "claude", "s", [entry]);
	expect(readStats(config.root).at(-1)?.repeat).toBe(false);
	recordStats(config.root, "command.before", "claude", "s", [entry]);
	expect(readStats(config.root).at(-1)?.repeat).toBe(true);
	recordStats(config.root, "command.before", "claude", "different-session", [
		entry,
	]);
	expect(readStats(config.root).at(-1)?.repeat).toBe(false);
});
