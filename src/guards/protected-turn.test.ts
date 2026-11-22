import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { runHook } from "../hook/run-hook";
import type { HookInput } from "../hook/types";
import { runShell } from "../run";
import { tempRepo } from "../test/repo";
import { clearTurnState, stateFile } from "../turn-state";

const policy = 'extends = ["recommended"]\n';
const trash = new Set<string>();
const sessions = new Set<string>();

afterEach(async () => {
	await Promise.all([
		...[...trash].map((path) => rm(path, { force: true, recursive: true })),
		...[...sessions].map(clearTurnState),
	]);
	trash.clear();
	sessions.clear();
});

async function setup(files: Record<string, string> = {}, custom = "") {
	const repo = await tempRepo();
	trash.add(repo.root);
	const base = await repo.commit("chore: add config", {
		"cagr.toml": policy + custom,
		...files,
	});
	await repo.git("switch", "-q", "-c", "feat/change");
	const session = crypto.randomUUID();
	sessions.add(stateFile(session));
	const hook = (event: HookInput["event"], tool_input?: object) =>
		runHook(
			"claude",
			event,
			JSON.stringify({ session_id: session, cwd: repo.root, tool_input }),
			repo.root,
		);
	const before = (command: string) => hook("command.before", { command });
	const stop = () => hook("turn.end");
	return { ...repo, base, hook, before, stop };
}

test("a shell edit with no edit tool blocks the stop until restored", async () => {
	const repo = await setup();
	const command = "sed -i.bak 's/\\[.*\\]/[]/' cagr.toml && rm cagr.toml.bak";
	expect(await repo.before(command)).toBe("");
	expect((await runShell(command, repo.root)).ok).toBe(true);

	const stopped = JSON.parse(await repo.stop());
	expect(stopped).toMatchObject({
		decision: "block",
		reason: expect.stringContaining(
			`restore --source=${repo.base} --staged --worktree -- cagr.toml`,
		),
	});
	await repo.git(
		"restore",
		`--source=${repo.base}`,
		"--staged",
		"--worktree",
		"--",
		"cagr.toml",
	);
	expect(await repo.stop()).toBe("");
	await repo.write("cagr.toml", `${policy}# Human edit between turns\n`);
	expect(await repo.before("git status")).toBe("");
	expect(await repo.stop()).toBe("");
});

test("baseline still applies if the shell deletes or breaks cagr.toml", async () => {
	const repo = await setup();
	expect(await repo.before("rm cagr.toml")).toBe("");
	await rm(join(repo.root, "cagr.toml"));
	expect(JSON.parse(await repo.stop()).decision).toBe("block");
	await repo.write("cagr.toml", "[[");
	expect(JSON.parse(await repo.stop())).toMatchObject({
		decision: "block",
		systemMessage: expect.stringContaining(
			"could not load the current configuration",
		),
	});
});

test("allows the origin/main version even if the local main copy differs", async () => {
	const repo = await setup();
	await repo.git("switch", "-q", "-c", "owner");
	const ownerHead = await repo.commit("chore: change CI", {
		"cagr.toml": `${policy}# owner's change\n`,
	});
	await repo.git("update-ref", "refs/remotes/origin/main", ownerHead);
	await repo.git("switch", "-q", "feat/change");
	expect(await repo.before("git merge origin/main")).toBe("");
	await repo.git("merge", "--ff-only", "origin/main");
	expect(await repo.stop()).toBe("");
});

test("allows the protected local branch's version when origin/main is absent", async () => {
	const repo = await setup();
	await repo.git("switch", "-q", "main");
	await repo.commit("chore: change CI", {
		"cagr.toml": `${policy}# owner's change\n`,
	});
	await repo.git("switch", "-q", "feat/change");
	expect(await repo.before("git merge main")).toBe("");
	await repo.git("merge", "--ff-only", "main");
	expect(await repo.stop()).toBe("");
});

test("does not blame pre-existing staged, unstaged or untracked changes", async () => {
	const repo = await setup({ "biome.json": "{}\n" });
	await repo.write("biome.json", '{"lineWidth": 80}\n');
	await repo.git("add", "biome.json");
	await repo.write("biome.json", '{"lineWidth": 90}\n');
	await repo.write(".env.local", "EXISTING=1\n");
	expect(await repo.before("git status")).toBe("");
	expect(await repo.stop()).toBe("");
});

test("restore instructions recover the separate staged and unstaged copies", async () => {
	const repo = await setup({ "biome.json": "{}\n" });
	const staged = '{"lineWidth": 80}\n';
	const worktree = '{"lineWidth": 90}\n';
	await repo.write("biome.json", staged);
	await repo.git("add", "biome.json");
	await repo.write("biome.json", worktree);
	expect(await repo.before("sed -i.bak 's/90/70/' biome.json")).toBe("");
	await repo.write("biome.json", '{"lineWidth": 70}\n');

	const { reason } = JSON.parse(await repo.stop());
	expect(reason).toContain("Restore the prior staged copy");
	expect(reason).toContain("Restore the prior working copy");
	for (const [, command = ""] of reason.matchAll(/`([^`]+)`/g)) {
		const result = await runShell(command, repo.root);
		expect(result.output).toBe("");
		expect(result.ok).toBe(true);
	}
	expect(await repo.git("show", ":biome.json")).toBe(staged.trim());
	expect(await Bun.file(join(repo.root, "biome.json")).text()).toBe(worktree);
	expect(await repo.stop()).toBe("");
});

test("restoring the disk and index still requires reversing a committed change", async () => {
	const repo = await setup();
	expect(await repo.before("git commit")).toBe("");
	await repo.commit("chore: change gate", {
		"cagr.toml": `${policy}# changed\n`,
	});
	await repo.git(
		"restore",
		`--source=${repo.base}`,
		"--staged",
		"--worktree",
		"--",
		"cagr.toml",
	);
	expect(JSON.parse(await repo.stop()).reason).toContain("Commit the reversal");
	await repo.git("commit", "-qm", "revert: restore gate");
	expect(await repo.stop()).toBe("");
});

test("a protected file added this turn must be removed and unstaged, with a three-stop escape", async () => {
	const repo = await setup();
	expect(await repo.before("git add .github/CODEOWNERS")).toBe("");
	await repo.write(".github/CODEOWNERS", "* @owner\n");
	await repo.git("add", ".github/CODEOWNERS");
	for (let attempt = 0; attempt < 2; attempt++) {
		const result = JSON.parse(await repo.stop());
		expect(result.decision).toBe("block");
		expect(result.reason).toContain(
			"update-index --force-remove -- .github/CODEOWNERS",
		);
		expect(result.reason).toContain("rm -f");
	}
	expect(JSON.parse(await repo.stop())).toEqual({
		systemMessage: expect.stringContaining(
			"Protected files still failing after 3 attempts",
		),
	});
});

test("a linked checkout uses its own starting commit", async () => {
	const repo = await setup();
	const sibling = `${repo.root}-sibling`;
	trash.add(sibling);
	await repo.git("worktree", "add", "-qb", "feat/sibling", sibling);
	const siblingCommit = await runShell(
		`printf '# already changed\n' >> cagr.toml && git commit -qam 'chore: own config'`,
		sibling,
	);
	expect(siblingCommit.ok).toBe(true);
	const head = (await runShell("git rev-parse HEAD", sibling)).stdout.trim();
	expect(
		await repo.before(
			`cd "${sibling}" && printf '# shell change\n' >> cagr.toml`,
		),
	).toBe("");
	await runShell("printf '# shell change\n' >> cagr.toml", sibling);
	const { reason } = JSON.parse(await repo.stop());
	expect(reason).toContain(join(sibling, "cagr.toml"));
	expect(reason).toContain(`--source=${head}`);
	await runShell("git restore -- cagr.toml", sibling);
	expect(await repo.stop()).toBe("");
});

test("a Git error in baseline capture allows the command and tells the human", async () => {
	const repo = await setup();
	await repo.write(".git/index", "bad index");
	const result = JSON.parse(await repo.before("cat README.md"));
	expect(result).toEqual({
		systemMessage: expect.stringContaining("Could not check protected files"),
	});
});

test("an allowed edit establishes the baseline and the human switch still protects the lockfile", async () => {
	const repo = await setup(
		{ "bun.lock": "old\n" },
		'[files]\ngate_edit_env = "TEST_PROTECTED_TURN_GATE"\n',
	);
	process.env.TEST_PROTECTED_TURN_GATE = "1";
	try {
		const edit = await repo.hook("file.before_edit", {
			file_path: join(repo.root, "README.md"),
		});
		expect(edit).toBe("");
		await repo.write("cagr.toml", `${policy}# human opened the gate\n`);
		await repo.write("bun.lock", "new\n");
		const result = JSON.parse(await repo.stop());
		expect(result.decision).toBe("block");
		expect(result.reason).toContain("bun.lock");
		expect(result.reason).not.toContain("cagr.toml");
	} finally {
		delete process.env.TEST_PROTECTED_TURN_GATE;
	}
});

test("ignored files are outside the shell check", async () => {
	const repo = await setup({ ".gitignore": ".env\n" });
	expect(await repo.before("echo A=1 > .env")).toBe("");
	await repo.write(".env", "A=1\n");
	expect(await repo.stop()).toBe("");
});

test("shell protection covers preset globs at depth and custom globs Git cannot express", async () => {
	const preset = await setup();
	expect(await preset.before("printf data > nested/pnpm-lock.yaml")).toBe("");
	await preset.write("nested/pnpm-lock.yaml", "data\n");
	expect(JSON.parse(await preset.stop()).reason).toContain(
		"nested/pnpm-lock.yaml",
	);

	const custom = await setup(
		{},
		'[[files.protected]]\nglob = "infra/{schema,policy}.txt"\nreason = "Ask the owner to update infra."\n',
	);
	expect(await custom.before("printf data > infra/schema.txt")).toBe("");
	await custom.write("infra/schema.txt", "data\n");
	expect(JSON.parse(await custom.stop()).reason).toContain("infra/schema.txt");
});
