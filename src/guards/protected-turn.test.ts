import { afterEach, expect, spyOn, test } from "bun:test";
import {
	copyFile,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { timeouts } from "../hook/handlers";
import { runHook } from "../hook/run-hook";
import type { HookInput } from "../hook/types";
import * as runner from "../run";
import { runShell, shellQuote } from "../run";
import { repoTestTimeout, roomyBudgets } from "../test/budgets";
import { localRegistry } from "../test/registry";
import { tempRepo } from "../test/repo";
import { clearTurnState, protectedNoticesDir, stateFile } from "../turn-state";
import { snapshotBudget } from "./protected-turn";

roomyBudgets(snapshotBudget, timeouts);

const policy = 'extends = ["recommended"]\n';
const trash = new Set<string>();
const sessions = new Set<string>();

afterEach(async () => {
	await Promise.all([
		...[...trash].map((path) => rm(path, { force: true, recursive: true })),
		...[...sessions].flatMap((file) => [
			clearTurnState(file),
			rm(protectedNoticesDir(file), { force: true, recursive: true }),
		]),
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
	const hook = (
		event: HookInput["event"],
		tool_input?: object,
		cwd = repo.root,
		agent: "claude" | "codex" = "claude",
	) =>
		runHook(
			agent,
			event,
			JSON.stringify({ session_id: session, cwd, tool_input }),
			cwd,
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

async function linkedSession(eol?: string) {
	const repo = await setup(
		{
			"pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
			"AGENTS.md": "# Rules\n",
			...(eol === "CRLF" && {
				".gitattributes": "pnpm-lock.yaml text eol=crlf\n",
			}),
		},
		'[[stack]]\nlanguage = "typescript"\npackage_manager = "pnpm"\n[[files.protected]]\nglob = "AGENTS.md"\nreason = "Ask the owner to change these rules."\n',
	);
	const sibling = `${repo.root}-sibling`;
	trash.add(sibling);
	await repo.git("switch", "-q", "main");
	await repo.git("worktree", "add", "-q", sibling, "feat/change");
	await repo.git("remote", "add", "origin", repo.root);
	const main = `git -C ${shellQuote(repo.root)}`;
	const before = (command: string) =>
		repo.hook("command.before", { command }, sibling);
	const stop = () => repo.hook("turn.end", undefined, sibling);
	return { ...repo, sibling, main, before, stop };
}

test("read-only git -C fetch and diff leave the main checkout's older staged files alone after a failed capture", async () => {
	const repo = await linkedSession();
	const lockfile = "lockfileVersion: '9.0'\n# Already staged by the owner\n";
	await repo.write("pnpm-lock.yaml", lockfile);
	await repo.write("AGENTS.md", "# Rules updated by the owner\n");
	await repo.git("add", "pnpm-lock.yaml", "AGENTS.md");
	await Bun.sleep(20);

	for (const command of [`${repo.main} fetch`, `${repo.main} diff`]) {
		await withoutGitStatus(repo, async () => {
			await repo.before(command);
		});
		expect((await runShell(command, repo.sibling)).ok).toBe(true);
	}
	expect(JSON.parse(await repo.stop())).toEqual({
		systemMessage: ["AGENTS.md", "pnpm-lock.yaml"]
			.map(
				(path) =>
					`${join(repo.root, path)}: changed before this turn or unknown; not restored`,
			)
			.join("\n"),
	});
	expect(await repo.git("show", ":pnpm-lock.yaml")).toBe(lockfile.trim());
	expect(await Bun.file(join(repo.root, "pnpm-lock.yaml")).text()).toBe(
		lockfile,
	);
});

test.each(["git -C", "tool workdir", "file.before_edit"])(
	"first touch via %s preserves the prior staged copy for a later shell write",
	async (placement) => {
		const repo = await linkedSession();
		await repo.write("AGENTS.md", "# Owner's staged rules\n");
		await repo.git("add", "AGENTS.md");
		const first =
			placement === "git -C"
				? await repo.before(`${repo.main} diff`)
				: placement === "tool workdir"
					? await repo.hook(
							"command.before",
							{ command: "git diff", workdir: repo.root },
							repo.sibling,
							"codex",
						)
					: await repo.hook(
							"file.before_edit",
							{ file_path: join(repo.root, "README.md") },
							repo.sibling,
						);
		expect(first).toBe("");
		const command = `printf '# shell change\\n' >> ${shellQuote(join(repo.root, "AGENTS.md"))}`;
		expect(await repo.before(command)).toBe("");
		expect((await runShell(command, repo.sibling)).ok).toBe(true);
		expect(JSON.parse(await repo.stop())).toMatchObject({
			decision: "block",
			reason: expect.stringContaining("Restore the prior staged copy"),
		});
	},
);

test("a git -C command with redirection snapshots the checkout where the shell writes", async () => {
	const repo = await linkedSession();
	const command = `${repo.main} diff > AGENTS.md`;
	expect(await repo.before(command)).toBe("");
	expect((await runShell(command, repo.sibling)).ok).toBe(true);
	expect(JSON.parse(await repo.stop())).toMatchObject({
		decision: "block",
		reason: expect.stringContaining(
			`restore --source=${repo.base} --staged --worktree -- AGENTS.md`,
		),
	});
});

test.each([
	["redirect", (absolute: string) => `printf 'new\\n' > ${absolute}`],
	["append", (absolute: string) => `printf 'new\\n' >> ${absolute}`],
	[
		"redirection after a subshell",
		(_: string, relative: string) =>
			`(cd / && pwd); printf 'new\\n' > ${relative}`,
	],
	[
		"tee",
		(_: string, relative: string) => `printf 'new\\n' | tee -a ${relative}`,
	],
	[
		"sed",
		(_: string, relative: string) => `sed -i.bak s/Rules/Changed/ ${relative}`,
	],
	["cp", (absolute: string) => `cp README.md ${absolute}`],
	["mv", (_: string, relative: string) => `mv replacement.txt ${relative}`],
])(
	"a literal %s write snapshots its checkout before a later git diff",
	async (_, write) => {
		const repo = await linkedSession();
		await writeFile(join(repo.sibling, "replacement.txt"), "new\n");
		const command = write(
			shellQuote(join(repo.root, "AGENTS.md")),
			shellQuote(relative(repo.sibling, join(repo.root, "AGENTS.md"))),
		);
		expect(await repo.before(command)).toBe("");
		expect((await runShell(command, repo.sibling)).ok).toBe(true);
		expect(await repo.before(`${repo.main} diff`)).toBe("");
		expect(JSON.parse(await repo.stop()).reason).toContain(
			`restore --source=${repo.base} --staged --worktree -- AGENTS.md`,
		);
	},
	repoTestTimeout,
);

test.each([">&", "&>", "&>>", ">|", "2>"])(
	"a literal %s redirection snapshots the destination checkout",
	async (operator) => {
		const repo = await linkedSession();
		const path = shellQuote(join(repo.root, "AGENTS.md"));
		expect(await repo.before(`printf x ${operator} ${path}`)).toBe("");
		await repo.write("AGENTS.md", "x");
		expect(await repo.before(`${repo.main} diff`)).toBe("");
		expect(JSON.parse(await repo.stop())).toMatchObject({
			decision: "block",
			reason: expect.stringContaining(
				`restore --source=${repo.base} --staged --worktree -- AGENTS.md`,
			),
		});
	},
	repoTestTimeout,
);

test(
	"tee resolves only the first 64 literal write targets",
	async () => {
		const repo = await linkedSession();
		const targets = Array.from({ length: 64 }, (_, i) => `out-${i}`);
		const path = join(repo.root, "AGENTS.md");
		const command = `printf 'new\\n' | tee ${targets.join(" ")} ${shellQuote(path)}`;
		await repo.write("AGENTS.md", "# Owner's working copy\n");
		await Bun.sleep(20);
		const notice = `${path}: changed before this turn or unknown; not restored`;
		await repo.before(command);
		expect(
			JSON.parse(await repo.hook("turn.end", undefined, repo.root)),
		).toEqual({
			systemMessage: notice,
		});
	},
	repoTestTimeout,
);

test("a recent shell write in the main checkout blocks after capture fails and older changes are reported once", async () => {
	const repo = await linkedSession();
	await repo.write("AGENTS.md", "# Owner's staged rules\n");
	await repo.git("add", "AGENTS.md");
	await Bun.sleep(20);
	expect(await repo.before("git status")).toBe("");
	const command = `cd ${shellQuote(repo.root)} && printf '# shell change\\n' >> cagr.toml`;
	await withoutGitStatus(repo, async () => {
		expect(JSON.parse(await repo.before(command)).systemMessage).toContain(
			"could not snapshot",
		);
	});
	expect((await runShell(command, repo.sibling)).ok).toBe(true);
	const stopped = JSON.parse(await repo.stop());
	expect(stopped.decision).toBe("block");
	expect(stopped.reason).toContain(join(repo.root, "cagr.toml"));
	expect(stopped.reason).not.toContain("AGENTS.md");
	expect(stopped.systemMessage).toContain(
		"AGENTS.md: changed before this turn or unknown; not restored",
	);
	expect(JSON.parse(await repo.stop()).systemMessage).toBeUndefined();
});

async function withoutGitStatus(
	repo: Awaited<ReturnType<typeof setup>>,
	action: () => Promise<void>,
) {
	const index = process.env.GIT_INDEX_FILE;
	await repo.write(".git/bad-index", "not a Git index");
	process.env.GIT_INDEX_FILE = join(repo.root, ".git/bad-index");
	try {
		await action();
	} finally {
		if (index === undefined) delete process.env.GIT_INDEX_FILE;
		else process.env.GIT_INDEX_FILE = index;
	}
}

test("a failed snapshot gives one notice and command guards still deny", async () => {
	const repo = await setup(
		{},
		'[[stack]]\nlanguage = "typescript"\npackage_manager = "bun"\n',
	);
	await withoutGitStatus(repo, async () => {
		const output = await repo.before("cat README.md");
		expect(output).not.toContain("cagr is off for this call");
		expect(JSON.parse(output).systemMessage).toContain("protected files");
		expect(await repo.before("cat README.md")).toBe("");
		expect(JSON.parse(await repo.before("npm install"))).toMatchObject({
			hookSpecificOutput: {
				permissionDecision: "deny",
				permissionDecisionReason: expect.stringContaining(
					"(cagr: package-manager)",
				),
			},
		});
	});
	expect(await repo.stop()).toBe("");
	await withoutGitStatus(repo, async () => {
		expect(
			JSON.parse(await repo.before("cat README.md")).systemMessage,
		).toContain("protected files");
	});
});

test.each(["unstaged", "committed"])(
	"the starting HEAD catches a %s shell write after snapshot capture failed",
	async (kind) => {
		const repo = await setup();
		const command = "printf '# shell change\\n' >> cagr.toml";
		await withoutGitStatus(repo, async () => {
			await repo.before(command);
		});
		expect((await runShell(command, repo.root)).ok).toBe(true);
		if (kind === "committed")
			await repo.git("commit", "-qam", "chore: change config");
		expect(await repo.before("cat README.md")).toBe("");
		expect(JSON.parse(await repo.stop())).toMatchObject({
			decision: "block",
			reason: expect.stringContaining(
				`cagr.toml\n  Review changes against ${repo.base}.`,
			),
		});
	},
);

test("turn end reports a dirty file of unknown age when even the starting HEAD is unavailable", async () => {
	const repo = await setup();
	const gitDir = process.env.GIT_DIR;
	process.env.GIT_DIR = join(repo.root, ".git/missing");
	try {
		const result = JSON.parse(await repo.before("cat README.md"));
		expect(result.systemMessage).toContain("could not snapshot");
	} finally {
		if (gitDir === undefined) delete process.env.GIT_DIR;
		else process.env.GIT_DIR = gitDir;
	}
	await rm(join(repo.root, "cagr.toml"));
	expect(JSON.parse(await repo.stop())).toEqual({
		systemMessage: `${join(repo.root, "cagr.toml")}: changed before this turn or unknown; not restored`,
	});
});

test("turn end reports older changes in its checkout even when no snapshot was taken", async () => {
	const repo = await setup({ "biome.json": "{}\n" });
	await repo.write("biome.json", '{"lineWidth": 80}\n');
	await repo.write(".cagr/guards.toml", "# generated by init\n");
	expect(JSON.parse(await repo.stop())).toEqual({
		systemMessage: `${join(repo.root, "biome.json")}: changed before this turn or unknown; not restored`,
	});
	expect(await repo.stop()).toBe("");
	await repo.write("biome.json", '{"lineWidth": 90}\n');
	expect(JSON.parse(await repo.stop()).systemMessage).toContain("biome.json");
	expect(await repo.stop()).toBe("");
	await repo.write("biome.json", '{"lineWidth": 80}\n');
	expect(await repo.stop()).toBe("");
});

test(
	"a different staged copy gets another notice even with the same unstaged bytes",
	async () => {
		const repo = await setup({ "biome.json": "{}\n" });
		const work = '{"lineWidth": 90}\n';
		for (const width of [80, 100]) {
			await repo.write("biome.json", `{"lineWidth": ${width}}\n`);
			await repo.git("add", "biome.json");
			await repo.write("biome.json", work);
			expect(JSON.parse(await repo.stop()).systemMessage).toContain(
				"biome.json",
			);
			expect(await repo.stop()).toBe("");
		}
	},
	repoTestTimeout,
);

test("turn end gives plain allow for old untracked files and a staged copy matching upstream", async () => {
	const repo = await setup({ "biome.json": "{}\n" });
	await repo.git("switch", "-q", "main");
	await repo.commit("chore: update rules", {
		"biome.json": '{"lineWidth": 80}\n',
	});
	await repo.git("switch", "-q", "feat/change");
	await repo.git(
		"restore",
		"--source=main",
		"--staged",
		"--worktree",
		"--",
		"biome.json",
	);
	await repo.write(".cagr/guards.toml", "# generated by init\n");
	expect(await repo.stop()).toBe("");
});

async function withSlowGitStatus(
	repo: Awaited<ReturnType<typeof setup>>,
	command: string,
) {
	const run = runner.run;
	// Only status should time out. HEAD and staged lockfile reads still use Git.
	const status = spyOn(runner, "run").mockImplementation(
		(argv, cwd, options) =>
			cwd === repo.root && argv[0] === "git" && argv[1] === "status"
				? Promise.resolve({
						ok: false,
						stdout: "",
						output: "Stopped after the snapshot deadline.",
						exitCode: null,
						ms: options?.timeoutMs ?? 0,
						timedOut: true,
					})
				: run(argv, cwd, options),
	);
	try {
		expect(JSON.parse(await repo.before(command)).systemMessage).toContain(
			"could not snapshot",
		);
	} finally {
		status.mockRestore();
	}
}

test("a timed out status still leaves the starting HEAD", async () => {
	const repo = await setup();
	await withSlowGitStatus(repo, "git status");
	await repo.commit("chore: change config", {
		"cagr.toml": `${policy}# committed\n`,
	});
	expect(JSON.parse(await repo.stop()).reason).toContain(
		`Review changes against ${repo.base}`,
	);
});

test("an older unstaged copy does not hide a protected commit after capture fails", async () => {
	const repo = await linkedSession();
	await repo.commit("chore: change rules", {
		"AGENTS.md": "# Separate version\n",
	});
	const other = await repo.git("rev-parse", "HEAD");
	await repo.git("reset", "--hard", repo.base);
	await repo.write("AGENTS.md", "# Owner's working copy\n");
	await Bun.sleep(20);
	await withoutGitStatus(repo, async () => {
		await repo.before(`${repo.main} diff`);
	});
	await repo.git("restore", `--source=${other}`, "--staged", "--", "AGENTS.md");
	await repo.git("commit", "-qm", "chore: commit separate version");
	const stopped = JSON.parse(await repo.stop());
	expect(stopped.decision).toBe("block");
	expect(stopped.reason).toContain("AGENTS.md");
	expect(await Bun.file(join(repo.root, "AGENTS.md")).text()).toBe(
		"# Owner's working copy\n",
	);
});

test.each(["LF", "CRLF"])(
	"restoring over the owner's %s lockfile after status times out blocks",
	async (eol) => {
		const repo = await linkedSession(eol);
		const staged = "lockfileVersion: '9.0'\n# Owner staged this\n";
		await repo.write("pnpm-lock.yaml", staged);
		await repo.git("add", "pnpm-lock.yaml");
		await repo.write(
			"pnpm-lock.yaml",
			"lockfileVersion: '9.0'\n# Owner's separate copy\n",
		);
		await withSlowGitStatus(
			repo,
			`${repo.main} restore --worktree -- pnpm-lock.yaml`,
		);
		await repo.git("restore", "--worktree", "--", "pnpm-lock.yaml");
		expect(await Bun.file(join(repo.root, "pnpm-lock.yaml")).text()).toBe(
			eol === "CRLF" ? staged.replaceAll("\n", "\r\n") : staged,
		);
		expect(JSON.parse(await repo.stop())).toMatchObject({
			decision: "block",
			reason: expect.stringContaining(
				"matches the prior staged copy. Check with the user",
			),
		});
	},
	repoTestTimeout,
);

test(
	"restoring the verified CRLF starting copy after status times out allows stop",
	async () => {
		const repo = await linkedSession("CRLF");
		const staged = "lockfileVersion: '9.0'\r\n# Owner staged this\r\n";
		await repo.write("pnpm-lock.yaml", staged);
		await repo.git("add", "pnpm-lock.yaml");
		await withSlowGitStatus(repo, `${repo.main} diff`);
		await repo.write("pnpm-lock.yaml", "# Temporary turn edit\r\n");
		await repo.git("restore", "--worktree", "--", "pnpm-lock.yaml");
		expect(await Bun.file(join(repo.root, "pnpm-lock.yaml")).text()).toBe(
			staged,
		);
		expect(JSON.parse(await repo.stop())).toEqual({
			systemMessage: `${join(repo.root, "pnpm-lock.yaml")}: changed before this turn or unknown; not restored`,
		});
	},
	repoTestTimeout,
);

test(
	"restoring over a captured lockfile copy points to its backup",
	async () => {
		const repo = await linkedSession();
		await repo.git("switch", "--detach");
		await repo.commit("chore: stage a version from main", {
			"pnpm-lock.yaml": "lockfileVersion: '9.0'\n# Staged\n",
		});
		await repo.git("update-ref", "refs/remotes/origin/main", "HEAD");
		await repo.git("reset", "--soft", repo.base);
		await repo.write(
			"pnpm-lock.yaml",
			"lockfileVersion: '9.0'\n# Owner's copy\n",
		);
		expect(await repo.before(`${repo.main} diff`)).toBe("");
		await repo.git("restore", "--worktree", "--", "pnpm-lock.yaml");
		expect(JSON.parse(await repo.stop())).toMatchObject({
			decision: "block",
			reason: expect.stringContaining(
				"Restore the prior working copy with `cp",
			),
		});
	},
	repoTestTimeout,
);

test(
	"an untouched staged lockfile gets its notice once after status times out",
	async () => {
		const repo = await linkedSession();
		await repo.write(
			"pnpm-lock.yaml",
			"lockfileVersion: '9.0'\n# Owner staged this\n",
		);
		await repo.git("add", "pnpm-lock.yaml");
		await Bun.sleep(20);
		await withSlowGitStatus(repo, `${repo.main} diff`);
		expect(JSON.parse(await repo.stop())).toEqual({
			systemMessage: `${join(repo.root, "pnpm-lock.yaml")}: changed before this turn or unknown; not restored`,
		});
		expect(await repo.hook("turn.end", undefined, repo.root)).toBe("");
	},
	repoTestTimeout,
);

test(
	"changing a pre-staged lockfile after status times out blocks",
	async () => {
		const repo = await linkedSession();
		const staged = "lockfileVersion: '9.0'\n# Owner staged this\n";
		await repo.write("pnpm-lock.yaml", staged);
		await repo.git("add", "pnpm-lock.yaml");
		await withSlowGitStatus(repo, `${repo.main} diff`);
		await repo.write("pnpm-lock.yaml", `${staged}# New staged edit\n`);
		await repo.git("add", "pnpm-lock.yaml");
		expect(JSON.parse(await repo.stop())).toMatchObject({
			decision: "block",
			reason: expect.stringContaining("pnpm-lock.yaml"),
		});
	},
	repoTestTimeout,
);

test("a Stop that fails open clears the baseline before the next turn", async () => {
	const repo = await linkedSession();
	expect(await repo.before(`${repo.main} diff`)).toBe("");
	await withoutGitStatus(repo, async () => {
		expect(JSON.parse(await repo.stop()).systemMessage).toContain(
			"cagr is off",
		);
	});
	await repo.write("AGENTS.md", "# Owner's change between turns\n");
	await Bun.sleep(20);
	expect(await repo.before("git diff")).toBe("");
	expect(JSON.parse(await repo.hook("turn.end", undefined, repo.root))).toEqual(
		{
			systemMessage: `${join(repo.root, "AGENTS.md")}: changed before this turn or unknown; not restored`,
		},
	);
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

const stackFor = (manager: string) =>
	`[[stack]]\nlanguage = "typescript"\npackage_manager = "${manager}"\n`;

/** A repo whose JavaScript stack uses `manager`, with pad@1.0.0 locked through a local registry. */
async function lockedRepo(
	manager: "bun" | "pnpm" | "npm" | "yarn",
	files: Record<string, string> = {},
) {
	const registry = await localRegistry({
		pad: ["1.0.0", "1.1.0"],
		zed: ["2.0.0"],
	});
	trash.add(registry.cache);
	stops.add(registry.stop);
	const config: Record<string, Record<string, string>> = {
		bun: {
			"bunfig.toml": `[install]\nregistry = "${registry.url}"\n[install.cache]\ndir = "${registry.cache}"\n`,
		},
		pnpm: {
			".npmrc": `registry=${registry.url}\nstore-dir=${registry.cache}/store\ncache-dir=${registry.cache}/meta\n`,
		},
		npm: { ".npmrc": `registry=${registry.url}\ncache=${registry.cache}\n` },
		yarn: {
			".yarnrc": `registry "${registry.url}"\ncache-folder "${registry.cache}"\n`,
		},
	};
	const repo = await setup(
		{
			".gitignore": "node_modules\n",
			"package.json": '{ "name": "app", "version": "1.0.0" }\n',
			...config[manager],
			...files,
		},
		stackFor(manager),
	);
	const add = async (spec: string) => {
		const root = files["pnpm-workspace.yaml"] ? "-w " : "";
		const result = await runShell(`${manager} add ${root}${spec}`, repo.root);
		if (!result.ok) throw new Error(result.output);
	};
	await add("pad@1.0.0");
	await repo.commit("chore: add pad", {});
	const lockfile = {
		bun: "bun.lock",
		pnpm: "pnpm-lock.yaml",
		npm: "package-lock.json",
		yarn: "yarn.lock",
	}[manager];
	const read = () => Bun.file(join(repo.root, lockfile)).text();
	return {
		...repo,
		registry,
		add,
		read,
		head: await repo.git("rev-parse", "HEAD"),
	};
}

const stops = new Set<() => Promise<void>>();
afterEach(async () => {
	await Promise.all([...stops].map((stop) => stop()));
	stops.clear();
});

for (const manager of ["bun", "pnpm", "npm", "yarn"] as const)
	test.skipIf(manager !== "bun" && Bun.which(manager) === null)(
		`a lockfile written by ${manager} add passes turn end`,
		async () => {
			const repo = await lockedRepo(manager);
			const before = await repo.read();
			expect(await repo.before(`${manager} add zed`)).toBe("");
			await repo.add("zed");
			expect(await repo.read()).not.toBe(before);
			expect(await repo.stop()).toBe("");
		},
		30_000,
	);

test("a local tarball added with bun add passes turn end", async () => {
	const repo = await lockedRepo("bun");
	await mkdir(join(repo.root, "vendor"));
	await copyFile(
		repo.registry.tarball("zed", "2.0.0"),
		join(repo.root, "vendor/zed.tgz"),
	);
	expect(await repo.before("bun add ./vendor/zed.tgz")).toBe("");
	await repo.add("./vendor/zed.tgz");
	expect(await repo.read()).toContain("vendor/zed.tgz");
	expect(await repo.stop()).toBe("");
});

test("a local package named with file: and no ./ passes turn end", async () => {
	const repo = await lockedRepo("bun");
	await mkdir(join(repo.root, "vendor"));
	await copyFile(
		repo.registry.tarball("zed", "2.0.0"),
		join(repo.root, "vendor/zed.tgz"),
	);
	await repo.write(
		"package.json",
		'{ "name": "app", "version": "1.0.0", "dependencies": { "pad": "1.0.0", "zed": "file:vendor/zed.tgz" } }\n',
	);
	expect(await repo.before("bun install")).toBe("");
	expect((await runShell("bun install", repo.root)).ok).toBe(true);
	expect(await repo.read()).toContain("vendor/zed.tgz");
	expect(await repo.stop()).toBe("");
});

test("a hand edit bun would repair still blocks", async () => {
	const repo = await lockedRepo("bun");
	expect(await repo.before("sed -i.bak s/x/y/ bun.lock")).toBe("");
	const original = await repo.read();
	await repo.write(
		"bun.lock",
		original.replace(
			'"packages": {',
			'"packages": {\n    "orphan": ["orphan@9.9.9", "", {}, "sha512-AAAA"],\n',
		),
	);
	const { decision, reason } = JSON.parse(await repo.stop());
	expect(decision).toBe("block");
	expect(reason).toContain("looks edited by hand");
});

test("the check uses the manager config from the starting commit", async () => {
	const repo = await lockedRepo("bun");
	expect(await repo.before("bun add zed")).toBe("");
	await repo.add("zed");
	const empty = join(repo.root, ".empty-cache");
	await repo.write(
		"bunfig.toml",
		`[install]\nregistry = "http://127.0.0.1:9/"\n[install.cache]\ndir = "${empty}"\n`,
	);
	expect(await repo.stop()).toBe("");
});

test("a folder in place of the lockfile still blocks the other protected files", async () => {
	const repo = await lockedRepo("bun");
	expect(await repo.before("rm bun.lock && mkdir bun.lock")).toBe("");
	await rm(join(repo.root, "bun.lock"));
	await repo.write("bun.lock/inner", "x\n");
	await repo.write("cagr.toml", `${policy}# shell change\n`);
	const { decision, reason } = JSON.parse(await repo.stop());
	expect(decision).toBe("block");
	expect(reason).toContain("cagr.toml");
});

test.each([
	["an integrity hash", (text: string) => text.replace(/sha512-./, "sha512-A")],
	[
		"a resolved version",
		(text: string) => text.replace('"pad@1.0.0"', '"pad@1.1.0"'),
	],
])(
	"a hand edit to %s in bun.lock blocks with restore steps",
	async (_, edit) => {
		const repo = await lockedRepo("bun");
		const original = await repo.read();
		expect(await repo.before("sed -i.bak s/x/y/ bun.lock")).toBe("");
		await repo.write("bun.lock", edit(original));
		expect(await repo.read()).not.toBe(original);
		const { decision, reason } = JSON.parse(await repo.stop());
		expect(decision).toBe("block");
		expect(reason).toContain("looks edited by hand");
		expect(reason).toContain(
			`restore --source=${repo.head} --staged --worktree -- bun.lock`,
		);
	},
);

test("a lockfile bun cannot rebuild blocks with the fix", async () => {
	const repo = await lockedRepo("bun");
	expect(await repo.before("sed -i.bak s/x/y/ bun.lock")).toBe("");
	await repo.write(
		"package.json",
		'{ "name": "app", "version": "1.0.0", "dependencies": { "pad": "1.0.0", "absent": "^1.0.0" } }\n',
	);
	await repo.write("bun.lock", (await repo.read()).replace("pad", "pad "));
	const { decision, reason } = JSON.parse(await repo.stop());
	expect(decision).toBe("block");
	expect(reason).toContain("could not check that bun wrote this lockfile");
	expect(reason).toContain("`bun install`");
	expect(reason).toContain("ask the user to make the dependency change");
	expect(reason).toContain(
		"or to commit the registry setting to the repo's bunfig.toml",
	);
});

// Runs several real Bun installs and Git snapshots for the committed and staged cases.
test(
	"a committed lockfile passes, a separately staged one does not",
	async () => {
		const repo = await lockedRepo("bun");
		expect(await repo.before("bun add zed")).toBe("");
		await repo.add("zed");
		await repo.git("commit", "-qam", "chore: add zed");
		expect(await repo.stop()).toBe("");

		expect(await repo.before("bun add pad@1.1.0")).toBe("");
		await repo.add("pad@1.1.0");
		await repo.git("add", "bun.lock");
		await repo.add("pad@1.0.0");
		expect(JSON.parse(await repo.stop()).reason).toContain(
			"Stage and commit the lockfile the package manager wrote",
		);
	},
	repoTestTimeout,
);

test("a lockfile from another package manager blocks", async () => {
	const repo = await lockedRepo("bun");
	expect(await repo.before("printf '{}' > package-lock.json")).toBe("");
	await repo.write("package-lock.json", "{}\n");
	expect(JSON.parse(await repo.stop()).reason).toContain(
		"uses bun, which does not write package-lock.json",
	);
});

test("a lockfile no stack covers names the missing stack", async () => {
	const repo = await setup({ "bun.lock": "{}\n" });
	expect(await repo.before("printf x >> bun.lock")).toBe("");
	await repo.write("bun.lock", "{}x\n");
	expect(JSON.parse(await repo.stop()).reason).toContain(
		"only when a [[stack]] with package_manager covers bun.lock",
	);
});

const missing = (manager: string) =>
	manager !== "bun" && Bun.which(manager) === null;

async function withEnv(
	vars: Record<string, string>,
	action: () => Promise<void>,
) {
	const saved = Object.fromEntries(
		Object.keys(vars).map((key) => [key, process.env[key]]),
	);
	Object.assign(process.env, vars);
	try {
		await action();
	} finally {
		for (const [key, value] of Object.entries(saved))
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
	}
}

test(
	"a snapshot that runs out of its budget gives the notice",
	async () => {
		const repo = await setup();
		const budget = snapshotBudget.commandMs;
		snapshotBudget.commandMs = 0;
		try {
			expect(
				JSON.parse(await repo.before("cat README.md")).systemMessage,
			).toContain("protected files");
		} finally {
			snapshotBudget.commandMs = budget;
		}
		await repo.write("cagr.toml", `${policy}# Shell change\n`);
		expect(JSON.parse(await repo.stop())).toMatchObject({
			decision: "block",
			reason: expect.stringContaining(
				"Review changes against the current commit",
			),
		});
	},
	repoTestTimeout,
);

for (const manager of ["bun", "pnpm", "npm"] as const)
	test.skipIf(missing(manager))(
		`${manager} config under the home folder does not reach the check`,
		async () => {
			const evil = await localRegistry({ "@evil/zed": ["1.0.0"] });
			stops.add(evil.stop);
			const home = await realpath(await mkdtemp(join(tmpdir(), "gw-home-")));
			trash.add(home);
			const files =
				manager === "bun"
					? [".bunfig.toml", ".config/.bunfig.toml"]
					: [".npmrc", ".config/pnpm/rc"];
			for (const file of files) {
				await mkdir(join(home, ".config/pnpm"), { recursive: true });
				await writeFile(
					join(home, file),
					manager === "bun"
						? `[install.scopes]\n"@evil" = "${evil.url}"\n`
						: `@evil:registry=${evil.url}\n`,
				);
			}
			const corepack =
				process.env.COREPACK_HOME ?? join(homedir(), ".cache/node/corepack");
			await withEnv(
				{
					HOME: home,
					XDG_CONFIG_HOME: join(home, ".config"),
					COREPACK_HOME: corepack,
				},
				async () => {
					const repo = await lockedRepo(manager);
					expect(await repo.before(`${manager} add @evil/zed`)).toBe("");
					await repo.add("@evil/zed");
					expect(await repo.read()).toContain("@evil/zed");
					const { decision, reason } = JSON.parse(await repo.stop());
					expect(decision).toBe("block");
					expect(reason).toContain(`${manager} wrote this lockfile`);
				},
			);
		},
		30_000,
	);

for (const manager of ["bun", "pnpm", "npm", "yarn"] as const)
	test.skipIf(missing(manager))(
		`a workspace planted above the temp folder does not capture the ${manager} check`,
		async () => {
			const repo = await lockedRepo(manager);
			const planted = await realpath(await mkdtemp(join(tmpdir(), "gw-tmp-")));
			trash.add(planted);
			await writeFile(
				join(planted, "package.json"),
				JSON.stringify({
					name: "planted",
					private: true,
					workspaces: ["**"],
					packageManager: "yarn@4.10.3",
				}),
			);
			await writeFile(
				join(planted, "pnpm-workspace.yaml"),
				"packages:\n  - '**'\n",
			);
			// The check makes its temp folder under TMPDIR, so the planted files sit above it.
			await withEnv({ TMPDIR: planted }, async () => {
				expect(await repo.before(`${manager} add zed`)).toBe("");
				await repo.add("zed");
				expect(await repo.stop()).toBe("");
			});
		},
		30_000,
	);

const pnpmfile = `const { basename } = require('node:path')
module.exports = { hooks: { readPackage(pkg) { pkg.description = basename('seen'); return pkg } } }
`;

test.skipIf(missing("pnpm"))(
	"pnpm add in a repo with a pnpmfile passes turn end",
	async () => {
		const repo = await lockedRepo("pnpm", { ".pnpmfile.cjs": pnpmfile });
		expect(await repo.read()).toContain("pnpmfileChecksum");
		expect(await repo.before("pnpm add zed")).toBe("");
		await repo.add("zed");
		expect(await repo.stop()).toBe("");
	},
	30_000,
);

test.skipIf(missing("pnpm"))(
	"pnpm add with a pnpmfile at a configured path passes turn end",
	async () => {
		const repo = await lockedRepo("pnpm", {
			"pnpm-workspace.yaml": "pnpmfile: tools/hooks.cjs\n",
			"tools/hooks.cjs": pnpmfile,
		});
		expect(await repo.read()).toContain("pnpmfileChecksum");
		expect(await repo.before("pnpm add zed")).toBe("");
		await repo.add("zed");
		expect(await repo.stop()).toBe("");
	},
	30_000,
);

test.skipIf(missing("pnpm"))(
	"a pnpmfile changed during the turn blocks the lockfile",
	async () => {
		const repo = await lockedRepo("pnpm", { ".pnpmfile.cjs": pnpmfile });
		expect(await repo.before("pnpm add zed")).toBe("");
		await repo.write(".pnpmfile.cjs", pnpmfile.replace("seen", "changed"));
		await repo.add("zed");
		const { decision, reason } = JSON.parse(await repo.stop());
		expect(decision).toBe("block");
		expect(reason).toContain(
			".pnpmfile.cjs differs from the last commit. A pnpmfile runs inside pnpm",
		);
	},
	30_000,
);

test.skipIf(missing("pnpm"))(
	"a catalog entry added to pnpm-workspace.yaml passes turn end",
	async () => {
		const repo = await lockedRepo("pnpm", {
			"pnpm-workspace.yaml": "packages:\n  - lib\n",
			"lib/package.json": '{ "name": "lib", "version": "1.0.0" }\n',
		});
		expect(await repo.before("pnpm install")).toBe("");
		await repo.write(
			"pnpm-workspace.yaml",
			"packages:\n  - lib\ncatalog:\n  zed: 2.0.0\n",
		);
		await repo.add("zed@catalog:");
		expect(await repo.read()).toContain("zed");
		expect(await repo.stop()).toBe("");
	},
	30_000,
);

test.skipIf(missing("pnpm"))(
	"a repeated key in pnpm-lock.yaml blocks",
	async () => {
		const repo = await lockedRepo("pnpm");
		expect(await repo.before("sed -i.bak s/x/y/ pnpm-lock.yaml")).toBe("");
		await repo.add("zed");
		const text = await repo.read();
		await repo.write(
			"pnpm-lock.yaml",
			text.replace(
				"\npackages:\n",
				"\npackages:\n\n  zed@2.0.0:\n    resolution: {integrity: sha512-AAAA}\n",
			),
		);
		expect(Bun.YAML.parse(await repo.read())).toEqual(Bun.YAML.parse(text));
		const { decision, reason } = JSON.parse(await repo.stop());
		expect(decision).toBe("block");
		expect(reason).toContain("looks edited by hand");
	},
	30_000,
);

test("a repeated key in bun.lock blocks", async () => {
	const repo = await lockedRepo("bun");
	expect(await repo.before("sed -i.bak s/x/y/ bun.lock")).toBe("");
	await repo.add("zed");
	const text = await repo.read();
	await repo.write(
		"bun.lock",
		text.replace(
			'"packages": {',
			'"packages": {\n    "zed": ["zed@2.0.0", "", {}, "sha512-AAAA"],',
		),
	);
	expect(Bun.JSONC.parse(await repo.read())).toEqual(Bun.JSONC.parse(text));
	const { decision, reason } = JSON.parse(await repo.stop());
	expect(decision).toBe("block");
	expect(reason).toContain("looks edited by hand");
});

test.skipIf(missing("pnpm"))(
	"a pnpmfile checked out with CRLF line ends passes turn end",
	async () => {
		const repo = await lockedRepo("pnpm", {
			".gitattributes": ".pnpmfile.cjs eol=crlf\n",
			".pnpmfile.cjs": pnpmfile.replaceAll("\n", "\r\n"),
		});
		expect(
			await repo.git("cat-file", "blob", "HEAD:.pnpmfile.cjs"),
		).not.toContain("\r");
		expect(await repo.before("pnpm add zed")).toBe("");
		await repo.add("zed");
		expect(await repo.stop()).toBe("");
	},
	30_000,
);

test("a lockfile whose starting copy cannot be read says so", async () => {
	const repo = await lockedRepo("bun");
	expect(await repo.before("bun add zed")).toBe("");
	await repo.add("zed");
	const oid = await repo.git("rev-parse", "HEAD:bun.lock");
	await rm(join(repo.root, ".git/objects", oid.slice(0, 2), oid.slice(2)));
	const { decision, reason } = JSON.parse(await repo.stop());
	expect(decision).toBe("block");
	expect(reason).toContain(
		"could not read this lockfile as it was at the start of the turn",
	);
});
