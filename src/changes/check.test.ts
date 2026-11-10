import { expect, test } from "bun:test";
import { chmodSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { ci } from "../ci";
import { resolveConfig } from "../config/load";
import { handle } from "../hook/handlers";
import { tempRepo } from "../test/repo";
import { checkChanges, collect } from "./check";
import { rule } from "./rules.test";

async function setup() {
	const repo = await tempRepo();
	await repo.commit("chore: baseline", {
		"src/a.ts": "old",
		"schema.json": "old",
		"migrations/old.sql": "old",
		".gitignore": "ignored\n",
	});
	await repo.git("checkout", "-b", "feat/x");
	const config = resolveConfig({}, repo.root, "cagr.toml");
	config.changes.rules = [rule()];
	return { repo, config };
}
test("working tree net content, not staging, supplies companions; committed input ignores dirt", async () => {
	const { repo, config } = await setup();
	await repo.write("src/a.ts", "new");
	await repo.write("schema.json", "new");
	await repo.git("add", "-A");
	await repo.write("schema.json", "old");
	expect((await checkChanges(config)).ok).toBe(false);
	expect((await collect(config)).changes.map((c) => c.path)).toEqual([
		"src/a.ts",
	]);
	await repo.write("schema.json", "new");
	expect((await checkChanges(config)).ok).toBe(true);
	expect((await collect(config, { committed: true })).changes).toEqual([]);
	await repo.commit("feat: source", { "schema.json": "old" });
	await repo.write("schema.json", "new");
	expect((await checkChanges(config, { committed: true })).ok).toBe(false);
	expect((await checkChanges(config)).ok).toBe(true);
});
test("NUL paths, ignored untracked, deletions, rename, modes and symlinks survive without changing index", async () => {
	const { repo, config } = await setup();
	await repo.git("mv", "migrations/old.sql", "migrations/new.sql");
	chmodSync(join(repo.root, "src/a.ts"), 0o755);
	rmSync(join(repo.root, "schema.json"));
	symlinkSync("src/a.ts", join(repo.root, "schema.json"));
	const odd = "space tab\tline\n[glob].ts";
	await repo.write(odd, "new");
	await repo.write("ignored", "ignore");
	const index = await repo.git("rev-parse", "--git-path", "index");
	const before = readFileSync(join(repo.root, index));
	const snapshot = await collect(config);
	expect(snapshot.changes).toContainEqual({
		path: odd,
		status: "A",
		regular: true,
	});
	expect(snapshot.changes).toContainEqual({
		path: "schema.json",
		status: "T",
		regular: false,
	});
	expect(
		snapshot.changes.some(
			(c) => c.path === "migrations/old.sql" && c.status === "D",
		),
	).toBe(true);
	expect(
		snapshot.changes.some((c) => c.path === "src/a.ts" && c.status === "M"),
	).toBe(true);
	expect(snapshot.changes.some((c) => c.path === "ignored")).toBe(false);
	expect(readFileSync(join(repo.root, index))).toEqual(before);
});
test("multiple commits retain branch obligations and branch new migration stays an addition", async () => {
	const { repo, config } = await setup();
	await repo.commit("feat: source", {
		"src/a.ts": "new",
		"migrations/new.sql": "one",
	});
	await repo.commit("fix: migration", { "migrations/new.sql": "two" });
	expect(
		(await collect(config)).changes.find((c) => c.path === "migrations/new.sql")
			?.status,
	).toBe("A");
	expect((await checkChanges(config)).ok).toBe(false);
	await repo.write("gone", "temporary");
	await repo.git("add", "gone");
	rmSync(join(repo.root, "gone"));
	expect((await collect(config)).changes.some((c) => c.path === "gone")).toBe(
		false,
	);
});
test("missing baseline and deadline are unchecked and hook errors fail open", async () => {
	const { repo, config } = await setup();
	config.git.protected_branch = "missing";
	expect((await checkChanges(config)).unchecked).toBe(true);
	const decision = await handle(
		{
			event: "turn.end",
			sessionId: crypto.randomUUID(),
			cwd: repo.root,
			command: null,
			files: [],
		},
		config,
	);
	expect(decision.kind).toBe("allow");
	expect("notice" in decision && decision.notice).toContain("Unchecked");
	expect((await checkChanges(config, { deadline: 0 })).unchecked).toBe(true);
	expect((await ci(config, { cwd: repo.root, env: {} })).checks[0]?.ok).toBe(
		false,
	);
});
test("shell edits with no recorded paths block twice then escape, review disabled", async () => {
	const { repo, config } = await setup();
	config.review.enabled = false;
	await repo.write("src/a.ts", "new");
	const input = {
		event: "turn.end" as const,
		sessionId: crypto.randomUUID(),
		cwd: repo.root,
		command: null,
		files: [],
	};
	expect((await handle(input, config)).kind).toBe("block");
	expect((await handle(input, config)).kind).toBe("block");
	const third = await handle(input, config);
	expect(third.kind).toBe("allow");
	expect("notice" in third && third.notice).toContain("still failing");
});
test("CI distinct change result ignores dirty companion and rejects wrong PR head", async () => {
	const { repo, config } = await setup();
	await repo.commit("feat: source", { "src/a.ts": "new" });
	await repo.write("schema.json", "new");
	const result = await ci(config, { cwd: repo.root, env: {} });
	expect(result.checks.find((c) => c.name === "Change rules")?.ok).toBe(false);
	expect(result.checks.find((c) => c.name === "Clean checkout")?.ok).toBe(
		false,
	);
});

test("conflicts, shallow history and multiple merge bases are unchecked", async () => {
	const { repo, config } = await setup();
	const base = await repo.git("rev-parse", "main");
	const tree = await repo.git("rev-parse", "HEAD^{tree}");
	const a = await repo.git("commit-tree", tree, "-p", base, "-m", "a");
	const b = await repo.git("commit-tree", tree, "-p", base, "-m", "b");
	const x = await repo.git("commit-tree", tree, "-p", a, "-p", b, "-m", "x");
	const y = await repo.git("commit-tree", tree, "-p", b, "-p", a, "-m", "y");
	await repo.git("update-ref", "refs/heads/ambiguous", y);
	await repo.git("reset", "--hard", x);
	expect((await checkChanges(config, { base: "ambiguous" })).unchecked).toBe(
		true,
	);
	await repo.write(".git/shallow", `${x}\n`);
	expect((await checkChanges(config)).output).toContain("shallow");
	rmSync(join(repo.root, ".git/shallow"));
	await repo.git("checkout", "main");
	await repo.commit("fix: target", { "src/a.ts": "target" });
	await repo.git("checkout", "feat/x");
	await repo.commit("fix: branch", { "src/a.ts": "branch" });
	await repo.git("merge", "main").catch(() => {});
	expect((await checkChanges(config)).output).toContain("unmerged");
});

test("mode changes and index flags cannot hide working-tree content; real index stays unchanged", async () => {
	const { repo, config } = await setup();
	await repo.git("config", "core.filemode", "false");
	await repo.git("update-index", "--assume-unchanged", "src/a.ts");
	await repo.git("update-index", "--skip-worktree", "schema.json");
	await repo.write("src/a.ts", "new");
	await repo.write("schema.json", "new");
	chmodSync(join(repo.root, "migrations/old.sql"), 0o755);
	const index = readFileSync(join(repo.root, ".git/index"));
	const changes = (await collect(config)).changes;
	expect(changes.some((c) => c.path === "src/a.ts" && c.status === "M")).toBe(
		true,
	);
	expect(
		changes.some((c) => c.path === "schema.json" && c.status === "M"),
	).toBe(true);
	expect(
		changes.some((c) => c.path === "migrations/old.sql" && c.status === "M"),
	).toBe(true);
	expect(readFileSync(join(repo.root, ".git/index"))).toEqual(index);
});

test("nested config uses one path root for tracked and untracked inputs and CI commands", async () => {
	const { repo } = await setup();
	await repo.commit("chore: nested", {
		"app/cagr.toml": "",
		"app/src/a.ts": "old",
		"app/schema.json": "old",
	});
	await repo.git("branch", "-f", "main", "HEAD");
	const config = resolveConfig(
		{ stack: [{ language: "typescript", on_turn_end: ["test -f src/a.ts"] }] },
		join(repo.root, "app"),
		join(repo.root, "app/cagr.toml"),
	);
	config.changes.rules = [rule()];
	await repo.commit("feat: nested source", { "app/src/a.ts": "new" });
	await repo.write("app/schema.json", "new");
	expect((await collect(config)).changes.map((c) => c.path).sort()).toEqual([
		"schema.json",
		"src/a.ts",
	]);
	expect((await checkChanges(config)).ok).toBe(true);
	await repo.commit("feat: nested companion", {});
	const result = await ci(config, { cwd: repo.root, env: {} });
	expect(result.checks.find((c) => c.name === "Change rules")?.ok).toBe(true);
	expect(result.checks.find((c) => c.name === "Checks")?.ok).toBe(true);
});

test("unreadable and malformed event JSON produce an unchecked CI check", async () => {
	const { repo, config } = await setup();
	for (const path of [
		join(repo.root, "missing-event.json"),
		join(repo.root, "event.json"),
	]) {
		if (path.endsWith("/event.json"))
			await repo.write("event.json", "not json");
		const result = await ci(config, {
			cwd: repo.root,
			env: { GITHUB_EVENT_PATH: path },
		});
		expect(result.ok).toBe(false);
		expect(result.checks.find((c) => c.name === "PR head")?.output).toContain(
			"Unchecked",
		);
	}
});

test("collection retries one race, and repeated races are unchecked", async () => {
	const runner = await import("../run");
	const { spyOn } = await import("bun:test");
	const { repo, config } = await setup();
	await repo.write("src/a.ts", "changed");
	const original = runner.run;
	for (const persistent of [false, true]) {
		let diffs = 0;
		const spy = spyOn(runner, "run").mockImplementation(
			async (argv, cwd, options) => {
				const result = await original(argv, cwd, options);
				if (cwd === repo.root && argv.includes("--numstat")) {
					diffs++;
					if (persistent || diffs === 2)
						await repo.write("src/a.ts", `content ${diffs}`);
				}
				return result;
			},
		);
		try {
			const result = await checkChanges(config);
			expect(diffs).toBe(4);
			expect(result.unchecked).toBe(persistent);
		} finally {
			spy.mockRestore();
		}
	}
});

test("turn commands share the deadline and a timeout is visibly unchecked", async () => {
	const { repo, config } = await setup();
	config.changes.rules = [];
	config.stack = [
		{
			language: "typescript",
			package_manager: "bun",
			paths: ["**"],
			extensions: ["ts"],
			on_edit: [],
			on_turn_end: ["bun -e 'await Bun.sleep(1000)'"],
		},
	];
	const { timeouts } = await import("../hook/handlers");
	const original = timeouts.onTurnEndMs;
	timeouts.onTurnEndMs = 30;
	const input = {
		event: "file.after_edit" as const,
		sessionId: crypto.randomUUID(),
		cwd: repo.root,
		command: null,
		files: [join(repo.root, "src/a.ts")],
	};
	try {
		await handle(input, config);
		const result = await handle({ ...input, event: "turn.end" }, config);
		expect(result.kind).toBe("allow");
		expect("notice" in result && result.notice).toContain("Unchecked");
	} finally {
		timeouts.onTurnEndMs = original;
	}
});

test("a parent symlink introduced during collection is captured without reading outside content", async () => {
	const runner = await import("../run");
	const { spyOn } = await import("bun:test");
	const { renameSync, mkdtempSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { repo, config } = await setup();
	await repo.write("src/a.ts", "changed");
	const outside = mkdtempSync(join(tmpdir(), "cagr-outside-"));
	writeFileSync(join(outside, "a.ts"), "outside");
	const original = runner.run;
	let replaced = false;
	const spy = spyOn(runner, "run").mockImplementation(
		async (argv, cwd, options) => {
			const result = await original(argv, cwd, options);
			if (!replaced && cwd === repo.root && argv.includes("--numstat")) {
				replaced = true;
				renameSync(join(repo.root, "src"), join(repo.root, "saved-src"));
				symlinkSync(outside, join(repo.root, "src"));
			}
			return result;
		},
	);
	try {
		const result = await checkChanges(config);
		expect(result.unchecked).toBe(false);
		expect(
			result.snapshot?.changes.some(
				(c) => c.path === "src/a.ts" && c.status === "D",
			),
		).toBe(true);
		expect(
			result.snapshot?.changes.some(
				(c) => c.path === "src" && c.regular === false,
			),
		).toBe(true);
	} finally {
		spy.mockRestore();
	}
});
