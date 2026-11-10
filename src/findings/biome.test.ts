import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../run";
import { tempRepo } from "../test/repo";
import { captureBaseline, compareFindings } from "./baseline";
import { findingCommand } from "./command";

const fixture = (name: string) =>
	readFileSync(join(import.meta.dir, "fixtures", `biome-${name}.txt`), "utf8");
const config = {
	linter: { rules: { preset: "none", suspicious: { noDebugger: "error" } } },
};
async function setup() {
	const repo = await tempRepo();
	mkdirSync(join(repo.root, "node_modules/.bin"), { recursive: true });
	symlinkSync(
		resolve(import.meta.dir, "../../node_modules/.bin/biome"),
		join(repo.root, "node_modules/.bin/biome"),
	);
	await repo.write("biome.json", JSON.stringify(config));
	await repo.write("src/sample.js", fixture("baseline"));
	const session = crypto.randomUUID();
	captureBaseline(repo.root, session, join(repo.root, "src/sample.js"));
	return { ...repo, session };
}

test("Biome file comparison uses real config and binary for lint and check", async () => {
	for (const command of [
		"bunx biome lint --fix {files}",
		"bunx biome check --write --no-errors-on-unmatched {files}",
	]) {
		const { root, write, session } = await setup();
		for (const [name, count] of [
			["inserted", 0],
			["added", 1],
			["replaced", 1],
			["edited", 1],
		] as const) {
			await write("src/sample.js", fixture(name));
			// check also reports formatting and assists, which must stay strict.
			const compared = await compareFindings(
				command,
				["src/sample.js"],
				root,
				session,
			);
			if (command.includes(" check") && ["added", "replaced"].includes(name))
				expect(compared).toBeNull();
			else {
				expect(compared).not.toBeNull();
				expect(compared?.problems).toHaveLength(count);
			}
		}
	}
});

test("missing, inherited, nested, ignored and unsupported config stays strict", async () => {
	for (const kind of [
		"missing",
		"extends",
		"nested",
		"ignored",
		"vcs",
		"overrides",
		"jsonc",
	]) {
		const { root, write, session } = await setup();
		if (kind === "missing") {
			const { rmSync } = await import("node:fs");
			rmSync(join(root, "biome.json"));
		}
		if (kind === "extends")
			await write(
				"biome.json",
				JSON.stringify({ ...config, extends: ["./base.json"] }),
			);
		if (kind === "nested") await write("src/biome.json", "{}");
		if (kind === "ignored")
			await write(
				"biome.json",
				JSON.stringify({ ...config, files: { includes: ["**", "!src/**"] } }),
			);
		if (kind === "overrides")
			await write("biome.json", JSON.stringify({ ...config, overrides: [] }));
		if (kind === "vcs") {
			await write(".gitignore", "src/sample.js\n");
			await write(
				"biome.json",
				JSON.stringify({
					...config,
					vcs: { enabled: true, clientKind: "git", useIgnoreFile: true },
				}),
			);
		}
		if (kind === "jsonc") {
			const { rmSync } = await import("node:fs");
			rmSync(join(root, "biome.json"));
			await write("biome.jsonc", `// comment\n${JSON.stringify(config)}`);
		}
		await write("src/sample.js", fixture("inserted"));
		const compared = await compareFindings(
			"biome lint {files}",
			["src/sample.js"],
			root,
			session,
		);
		if (kind === "jsonc") expect(compared).toEqual({ old: 1, problems: [] });
		else expect(compared).toBeNull();
	}
});

test("Biome timeouts and truncated or unknown reports stay strict; workspace is removed", async () => {
	const { root, session } = await setup();
	for (const mode of ["timeout", "truncated", "path", "empty", "stderr"]) {
		let target = "";
		const execute: typeof run = async (argv, cwd, options) => {
			target = argv.at(-1) as string;
			const result = await run(argv, cwd, options);
			if (mode === "timeout") return { ...result, timedOut: true };
			if (mode === "stderr") return { ...result, stderr: "unknown error" };
			const data = JSON.parse(result.stdout);
			if (mode === "truncated") data.summary.diagnosticsNotPrinted = 1;
			if (mode === "path") data.diagnostics[0].location.path = "/wrong.js";
			if (mode === "empty") data.diagnostics = [];
			return { ...result, stdout: JSON.stringify(data) };
		};
		expect(
			await compareFindings(
				"biome lint {files}",
				["src/sample.js"],
				root,
				session,
				performance.now() + 750,
				execute,
			),
		).toBeNull();
		expect(target).toBe(join(root, "src/sample.js"));
	}
	let baselinePath = "";
	const execute: typeof run = async (argv, cwd, options) => {
		if (cwd !== root) baselinePath = argv.at(-1) as string;
		return run(argv, cwd, options);
	};
	expect(
		await compareFindings(
			"biome lint {files}",
			["src/sample.js"],
			root,
			session,
			performance.now() + 750,
			execute,
		),
	).toEqual({ old: 1, problems: [] });
	expect(await Bun.file(baselinePath).exists()).toBe(false);
	expect(baselinePath.startsWith(root)).toBe(false);
	for (const command of [
		"biome format {files}",
		"biome check --unsafe {files}",
		"biome check --config-path custom {files}",
	])
		expect(findingCommand(command)).toBeNull();
});

test("after-edit compares Biome terminal stderr and blocks a new lint error", async () => {
	const { resolveConfig } = await import("../config/load");
	const { handle } = await import("../hook/handlers");
	const { root, write, session } = await setup();
	const config = resolveConfig(
		{
			findings: { mode: "new" },
			stack: [
				{
					language: "javascript",
					on_edit: [
						"bunx biome check --write --no-errors-on-unmatched {files}",
					],
				},
			],
		},
		root,
		join(root, "cagr.toml"),
	);
	const event = {
		event: "file.after_edit" as const,
		sessionId: session,
		cwd: root,
		command: null,
		files: [join(root, "src/sample.js")],
	};
	await write("src/sample.js", fixture("inserted"));
	expect(await handle(event, config)).toMatchObject({
		kind: "allow",
		context: expect.stringContaining("1 existing findings"),
	});
	await write("src/sample.js", fixture("added"));
	expect(await handle(event, config)).toMatchObject({ kind: "block" });
	await write("biome.json", "invalid config");
	expect(await handle(event, config)).toMatchObject({ kind: "block" });
});
