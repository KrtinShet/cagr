import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import {
	copyFile,
	mkdir,
	mkdtemp,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../hook/run-hook";
import type { HookInput } from "../hook/types";
import { runShell } from "../run";
import { localRegistry } from "../test/registry";
import { tempRepo } from "../test/repo";
import { clearTurnState, stateFile } from "../turn-state";
import { snapshotBudget } from "./protected-turn";

// The real budget is tight, and a loaded test machine can miss it and change what turn end reports.
const budget = { ...snapshotBudget };
beforeAll(() => {
	snapshotBudget.commandMs = 10_000;
	snapshotBudget.toolMs = 10_000;
});
afterAll(() => {
	Object.assign(snapshotBudget, budget);
});

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

test("turn end asks for a manual check when even the starting HEAD is unavailable", async () => {
	const repo = await setup();
	const gitDir = process.env.GIT_DIR;
	process.env.GIT_DIR = join(repo.root, ".git/missing");
	try {
		const result = JSON.parse(await repo.before("cat README.md"));
		expect(result.systemMessage).toContain(
			"could not record a starting commit",
		);
	} finally {
		if (gitDir === undefined) delete process.env.GIT_DIR;
		else process.env.GIT_DIR = gitDir;
	}
	expect(JSON.parse(await repo.stop())).toMatchObject({
		decision: "block",
		reason: expect.stringContaining("Review protected-file changes"),
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
});

test("a committed lockfile passes, a separately staged one does not", async () => {
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
});

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

test("a snapshot that runs out of its budget gives the notice", async () => {
	const repo = await setup();
	snapshotBudget.commandMs = 0;
	try {
		expect(
			JSON.parse(await repo.before("cat README.md")).systemMessage,
		).toContain("protected files");
	} finally {
		snapshotBudget.commandMs = 10_000;
	}
});

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
				JSON.stringify({ name: "planted", private: true, workspaces: ["**"] }),
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

const pnpmfile =
	"module.exports = { hooks: { readPackage(pkg) { pkg.description = 'seen'; return pkg } } }\n";

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
