import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { brief } from "../brief";
import { resolveConfig } from "../config/load";
import { editChecks, handle } from "../hook/handlers";
import type { HookInput } from "../hook/types";
import type { RunResult } from "../run";
import { tempRepo } from "../test/repo";
import { clearTurnState, stateFile } from "../turn-state";
import { baselineFile, captureBaseline, compareFindings } from "./baseline";
import { findingCommand } from "./command";
import { newFindings } from "./match";
import { parseFindings } from "./parse";

const fixture = (name: string) =>
	readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
const result = (stdout: string, exitCode = 1): RunResult => ({
	ok: exitCode === 0,
	stdout,
	stderr: "",
	output: stdout,
	exitCode,
	timedOut: false,
	ms: 1,
});
for (const tool of ["eslint", "ruff"] as const)
	describe(tool, () => {
		const file = `/fixture/sample.${tool === "eslint" ? "js" : "py"}`;
		const findings = (name: string) =>
			parseFindings(tool, result(fixture(`${tool}-${name}.json`)), file) ?? [];
		const source = (name: string) => fixture(`${tool}-${name}.txt`);
		for (const [name, count] of [
			["inserted", 0],
			["added", 1],
			["replaced", 1],
			["edited", 1],
		] as const)
			test(name, () => {
				expect(findings("baseline")).toHaveLength(1);
				expect(
					newFindings(
						source("baseline"),
						source(name),
						findings("baseline"),
						findings(name),
					),
				).toHaveLength(count);
			});
		test("unparseable output, timeout, stderr and tool errors stay strict", () => {
			for (const value of [
				result("not JSON"),
				{ ...result(fixture(`${tool}-baseline.json`)), timedOut: true },
				{ ...result(fixture(`${tool}-baseline.json`)), stderr: "tool error" },
				result(fixture(`${tool}-baseline.json`), 2),
			])
				expect(parseFindings(tool, value, file)).toBeNull();
		});
		test("a baseline occurrence is consumed once", () => {
			const old = findings("baseline");
			expect(
				newFindings(source("baseline"), source("baseline"), old, [
					...old,
					...old,
				]),
			).toHaveLength(1);
		});
	});

test("recognizes direct tools through literal common launchers", () => {
	for (const launcher of ["", "bunx ", "npx ", "pnpm exec ", "uv run ", "uvx "])
		for (const command of [
			"eslint --fix {files}",
			"ruff check --fix --select F401 {files}",
		])
			expect(findingCommand(launcher + command)).not.toBeNull();
	for (const command of [
		"bun run lint",
		"eslint .",
		"eslint {files} .",
		"eslint --cache {files}",
		"eslint --format json {files}",
		"eslint {files} && false",
		"ruff format {files}",
		"biome lint {files}",
		"biome check --write {files}",
		"eslint {files} --config custom.js",
	])
		expect(findingCommand(command)).toBeNull();
});

test("Biome 2.6.6 stdin emits source and no JSON; keep strict", () => {
	expect(
		JSON.parse(fixture("biome-output.json")).diagnostics.length,
	).toBeGreaterThan(0);
	expect(() => JSON.parse(fixture("biome-stdin.txt"))).toThrow();
	expect(findingCommand("bunx biome lint {files}")).toBeNull();
});

test("ambiguous lines, changed severity, and over-budget diffs remain new", () => {
	const f = {
		code: "rule",
		message: "bad",
		severity: "error",
		line: 1,
		endLine: 1,
		column: 1,
	};
	expect(newFindings("x\nx", "x\nx", [f], [f])).toHaveLength(1);
	expect(
		newFindings("x", "x", [f], [{ ...f, severity: "warning" }]),
	).toHaveLength(1);
	expect(
		newFindings("x\n".repeat(1500), "x\n".repeat(1500), [f], [f]),
	).toHaveLength(1);
});

test("first-touch source survives clean stops, missing files, and sessions", async () => {
	const { root, write } = await tempRepo();
	const file = join(root, "a.js"),
		session = crypto.randomUUID();
	await write("a.js", "old");
	captureBaseline(root, session, file);
	await write("a.js", "new");
	captureBaseline(root, session, file);
	await clearTurnState(stateFile(session));
	expect(readFileSync(baselineFile(root, session, file), "utf8")).toBe("old");
	captureBaseline(root, "another", file);
	expect(readFileSync(baselineFile(root, "another", file), "utf8")).toBe("new");
	const absent = join(root, "new.js");
	captureBaseline(root, session, absent);
	expect(readFileSync(baselineFile(root, session, absent), "utf8")).toBe("");
	expect(
		await compareFindings("eslint {files}", ["uncaptured.js"], root, session),
	).toBeNull();
});

test("hook integration: mode all and CI strict, new mode inherited allow, new and turn-end block", async () => {
	const { root, write } = await tempRepo();
	const session = crypto.randomUUID(),
		file = join(root, "sample.js");
	const bin = join(root, "bin");
	mkdirSync(bin);
	const fixturePath = join(import.meta.dir, "fixtures");
	await write(
		"bin/eslint",
		`#!/usr/bin/env bun\nconst text = process.argv.includes('--stdin') ? await Bun.stdin.text() : await Bun.file('sample.js').text();\nconst name = text.startsWith('// header') ? 'inserted' : text.includes('another') ? 'added' : 'baseline';\nconst fixture = await Bun.file(${JSON.stringify(fixturePath)} + '/eslint-' + name + '.json').text();\nconsole.log(fixture.replaceAll('/fixture/sample.js', process.cwd() + '/sample.js'));\nprocess.exit(1);\n`,
	);
	const { chmodSync } = await import("node:fs");
	chmodSync(join(bin, "eslint"), 0o755);
	const previous = process.env.PATH;
	process.env.PATH = `${bin}:${previous}`;
	try {
		const config = resolveConfig(
			{
				findings: { mode: "new" },
				stack: [
					{
						language: "javascript",
						on_edit: ["eslint --fix {files}"],
						on_turn_end: ["eslint {files}"],
					},
				],
			},
			root,
			join(root, "cagr.toml"),
		);
		const event = (event: HookInput["event"]): HookInput => ({
			event,
			sessionId: session,
			cwd: root,
			command: null,
			files: [file],
		});
		await write("sample.js", fixture("eslint-baseline.txt"));
		expect((await handle(event("file.before_edit"), config)).kind).toBe(
			"allow",
		);
		await write("sample.js", fixture("eslint-inserted.txt"));
		expect(await handle(event("file.after_edit"), config)).toMatchObject({
			kind: "allow",
			context: expect.stringContaining("1 existing findings"),
		});
		expect((await handle(event("turn.end"), config)).kind).toBe("block");
		expect(await editChecks([file], config)).toHaveLength(1);
		config.findings.mode = "all";
		expect((await handle(event("file.after_edit"), config)).kind).toBe("block");
		config.findings.mode = "new";
		await write("sample.js", fixture("eslint-added.txt"));
		expect((await handle(event("file.after_edit"), config)).kind).toBe("block");
		const stack = config.stack[0];
		if (!stack) throw new Error("Missing stack");
		stack.on_edit = ["bun -e 'process.exit(1)'"];
		expect((await handle(event("file.after_edit"), config)).kind).toBe("block");
		rmSync(baselineFile(root, session, file));
		stack.on_edit = ["eslint {files}"];
		expect((await handle(event("file.after_edit"), config)).kind).toBe("block");
		expect(brief(config, [])).toContain(
			"turn-end checks, CI and code rules still must fully pass",
		);
	} finally {
		process.env.PATH = previous;
	}
});

test("findings config is opt-in and validates values", () => {
	expect(resolveConfig({}, "/tmp/nonexistent", "cagr.toml").findings.mode).toBe(
		"all",
	);
	expect(() =>
		resolveConfig(
			{ findings: { mode: "ignore" } },
			"/tmp/nonexistent",
			"cagr.toml",
		),
	).toThrow();
});

test("incomplete ESLint counts, fatal diagnostics and Ruff syntax errors stay strict", () => {
	const eslint = JSON.parse(fixture("eslint-baseline.json"));
	eslint[0].errorCount++;
	expect(
		parseFindings(
			"eslint",
			result(JSON.stringify(eslint)),
			"/fixture/sample.js",
		),
	).toBeNull();
	eslint[0].errorCount--;
	eslint[0].messages[0].fatal = true;
	expect(
		parseFindings(
			"eslint",
			result(JSON.stringify(eslint)),
			"/fixture/sample.js",
		),
	).toBeNull();
	const ruff = JSON.parse(fixture("ruff-baseline.json"));
	ruff[0].code = null;
	expect(
		parseFindings("ruff", result(JSON.stringify(ruff)), "/fixture/sample.py"),
	).toBeNull();
	expect(parseFindings("ruff", result("[]", 0), "/fixture/sample.py")).toEqual(
		[],
	);
	expect(parseFindings("ruff", result("[]"), "/fixture/sample.py")).toBeNull();
});

test("all lines in a multiline finding must remain unchanged", () => {
	const f = {
		code: "rule",
		message: "bad",
		severity: "error",
		line: 1,
		endLine: 2,
		column: 1,
	};
	expect(newFindings("first\nsecond", "first\nchanged", [f], [f])).toHaveLength(
		1,
	);
	expect(
		newFindings(
			"first\nsecond",
			"header\nfirst\nsecond",
			[f],
			[{ ...f, line: 2, endLine: 3 }],
		),
	).toHaveLength(0);
});
