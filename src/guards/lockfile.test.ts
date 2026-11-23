import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempRepo } from "../test/repo";
import {
	builtinsOnly,
	checkLockfile,
	isLockfile,
	type LockfileStack,
} from "./lockfile";

const roots = new Set<string>();
afterEach(async () => {
	await Promise.all(
		[...roots].map((root) => rm(root, { recursive: true, force: true })),
	);
	roots.clear();
});

const stack = (
	package_manager: LockfileStack["package_manager"],
	paths = ["**"],
	exclude_paths: string[] = [],
): LockfileStack => ({ paths, exclude_paths, package_manager });

async function check(path: string, stacks: LockfileStack[], write = true) {
	const repo = await tempRepo();
	roots.add(repo.root);
	if (write) await repo.write(path, "{}\n");
	return checkLockfile({
		root: repo.root,
		path,
		stacks,
		baseline: null,
		head: null,
		deadline: performance.now() + 10_000,
	});
}

test("only the JavaScript lockfiles are checked against their manager", () => {
	expect(
		["bun.lock", "web/pnpm-lock.yaml", "package-lock.json", "yarn.lock"].every(
			isLockfile,
		),
	).toBe(true);
	expect(
		["bun.lockb", "uv.lock", "Cargo.lock", "go.sum"].some(isLockfile),
	).toBe(false);
});

test("a lockfile with no covering stack names the missing package_manager", async () => {
	const verdict = await check("web/bun.lock", [
		stack(null),
		stack("bun", ["api/**"]),
		stack("bun", ["**"], ["web/**"]),
	]);
	expect(verdict?.message).toContain(
		"only when a [[stack]] with package_manager covers web/bun.lock",
	);
});

test("a lockfile the stack's manager does not write says which manager to use", async () => {
	const verdict = await check("package-lock.json", [stack("pnpm")]);
	expect(verdict?.message).toContain(
		"uses pnpm, which does not write package-lock.json",
	);
});

test("a JavaScript stack is chosen over another ecosystem's on the same paths", async () => {
	const other = await check("package-lock.json", [stack("uv"), stack("bun")]);
	expect(other?.message).toContain("uses bun, which does not write");
	const only = await check("bun.lock", [stack("uv")]);
	expect(only?.message).toContain("only when a [[stack]] with package_manager");
	const writer = await check("bun.lock", [stack("pnpm"), stack("bun")], false);
	expect(writer?.message).toContain("bun.lock is deleted");
});

test("a deleted lockfile, or a folder in its place, asks for a restore", async () => {
	const deleted = await check("bun.lock", [stack("bun")], false);
	expect(deleted?.message).toContain("bun.lock is deleted");
	const repo = await tempRepo();
	roots.add(repo.root);
	await repo.write("bun.lock/inner", "x\n");
	const verdict = await checkLockfile({
		root: repo.root,
		path: "bun.lock",
		stacks: [stack("bun")],
		baseline: null,
		head: null,
		deadline: performance.now() + 10_000,
	});
	expect(verdict?.message).toContain("bun.lock is not a regular file");
});

test("a Yarn 2 or later lockfile is not rebuilt", async () => {
	const repo = await tempRepo();
	roots.add(repo.root);
	const berry = "__metadata:\n  version: 8\n";
	await repo.write("yarn.lock", berry);
	const verdict = await checkLockfile({
		root: repo.root,
		path: "yarn.lock",
		stacks: [stack("yarn")],
		baseline: new TextEncoder().encode(berry),
		head: null,
		deadline: performance.now() + 10_000,
	});
	expect(verdict?.message).toContain("checks Yarn 1 lockfiles only");
});

test("other files are left to the plain protected-file check", async () => {
	expect(await check("Cargo.lock", [stack("bun")])).toBeNull();
});

const workspace = "packages:\n  - lib\noverrides:\n  pad: 1.0.0\n";

/** A pnpm repo with `workspace` committed, then `edited` written as the working pnpm-workspace.yaml. */
async function workspaceCheck(edited: string) {
	const repo = await tempRepo();
	roots.add(repo.root);
	const lockfile = "lockfileVersion: '9.0'\n";
	const head = await repo.commit("chore: add workspace", {
		"package.json": '{ "name": "app" }\n',
		"lib/package.json": '{ "name": "lib" }\n',
		"pnpm-workspace.yaml": workspace,
		"pnpm-lock.yaml": lockfile,
	});
	await repo.write("pnpm-workspace.yaml", edited);
	await repo.write("pnpm-lock.yaml", `${lockfile}# edited\n`);
	return checkLockfile({
		root: repo.root,
		path: "pnpm-lock.yaml",
		stacks: [stack("pnpm")],
		baseline: new TextEncoder().encode(lockfile),
		head,
		deadline: performance.now() + 10_000,
	});
}

test("a pnpm setting changed in pnpm-workspace.yaml is for a human", async () => {
	const verdict = await workspaceCheck(
		workspace.replace("pad: 1.0.0", "pad: 1.1.0"),
	);
	expect(verdict?.message).toContain(
		"pnpm-workspace.yaml differs from the last commit in pnpm settings other than packages, catalog and catalogs",
	);
});

test("a repeated key in pnpm-workspace.yaml blocks even when the last copy matches", async () => {
	const verdict = await workspaceCheck(
		`overrides:\n  pad: 1.1.0\n${workspace}`,
	);
	expect(verdict?.message).toContain(
		"reads pnpm-workspace.yaml as one block of top-level keys, each once",
	);
});

test("temp folders a killed check left behind are removed after an hour", async () => {
	const folder = await realpath(await mkdtemp(join(tmpdir(), "gw-tmp-")));
	roots.add(folder);
	const old = join(folder, "cagr-lockfile-old");
	const recent = join(folder, "cagr-lockfile-recent");
	await mkdir(old);
	await mkdir(recent);
	const hours = new Date(Date.now() - 2 * 3_600_000);
	await utimes(old, hours, hours);
	const saved = process.env.TMPDIR;
	process.env.TMPDIR = folder;
	try {
		await check("bun.lock", [stack("bun")]);
	} finally {
		if (saved === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = saved;
	}
	expect(existsSync(old)).toBe(false);
	expect(existsSync(recent)).toBe(true);
});

/** A repo with `committed` in its last commit and `edited` written over it, checked against `path`. */
async function editedCheck(
	path: string,
	manager: LockfileStack["package_manager"],
	committed:
		| Record<string, string>
		| ((root: string) => Record<string, string>),
	edited: Record<string, string>,
	after?: (repo: Awaited<ReturnType<typeof tempRepo>>) => Promise<unknown>,
) {
	const repo = await tempRepo();
	roots.add(repo.root);
	const files =
		typeof committed === "function" ? committed(repo.root) : committed;
	const head = await repo.commit("chore: add project", files);
	for (const [file, text] of Object.entries(edited))
		await repo.write(file, text);
	await after?.(repo);
	return checkLockfile({
		root: repo.root,
		path,
		stacks: [stack(manager)],
		baseline: new TextEncoder().encode(files[path] ?? ""),
		head,
		deadline: performance.now() + 10_000,
	});
}

test("a packageManager changed during the turn is for a human", async () => {
	const verdict = await editedCheck(
		"pnpm-lock.yaml",
		"pnpm",
		{
			"package.json": '{ "name": "app", "packageManager": "pnpm@11.22.0" }\n',
			"pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
		},
		{
			"package.json": '{ "name": "app", "packageManager": "pnpm@10.0.0" }\n',
			"pnpm-lock.yaml": "lockfileVersion: '9.0'\n# edited\n",
		},
	);
	expect(verdict?.message).toContain(
		"packageManager field in package.json is pnpm@10.0.0, and in the last commit pnpm@11.22.0",
	);
});

test("a Yarn 1 lockfile in a repo pinned to Yarn 2 or later is not rebuilt", async () => {
	const lockfile = "# yarn lockfile v1\n";
	const verdict = await editedCheck(
		"yarn.lock",
		"yarn",
		{
			"package.json": '{ "name": "app", "packageManager": "yarn@4.10.3" }\n',
			"yarn.lock": lockfile,
		},
		{ "yarn.lock": `${lockfile}\n` },
	);
	expect(verdict?.message).toContain("checks Yarn 1 lockfiles only");
});

test("a pnpmfile that loads a module from the repo is not run", async () => {
	const lockfile = "lockfileVersion: '9.0'\n";
	const verdict = await editedCheck(
		"pnpm-lock.yaml",
		"pnpm",
		{
			"package.json": '{ "name": "app" }\n',
			".pnpmfile.cjs":
				"const path = require('node:path')\nconst hooks = require('./tools/hooks')\nmodule.exports = { hooks }\n",
			"tools/hooks.js": "module.exports = {}\n",
			"pnpm-lock.yaml": lockfile,
		},
		{ "pnpm-lock.yaml": `${lockfile}# edited\n` },
	);
	expect(verdict?.message).toContain(
		"could not prove that .pnpmfile.cjs loads only Node built-ins",
	);
});

test("a pnpm setting changed in the root package.json is for a human", async () => {
	const lockfile = "lockfileVersion: '9.0'\n";
	const verdict = await editedCheck(
		"pnpm-lock.yaml",
		"pnpm",
		{
			"package.json": '{ "name": "app" }\n',
			"pnpm-lock.yaml": lockfile,
		},
		{
			"package.json":
				'{ "name": "app", "pnpm": { "overrides": { "pad": "1.1.0" } } }\n',
			"pnpm-lock.yaml": `${lockfile}# edited\n`,
		},
	);
	expect(verdict?.message).toContain(
		"The pnpm field in package.json differs from the last commit",
	);
});

test.skipIf(Bun.which("yarn") === null)(
	"Yarn 1 runs the yarn-path release from the starting commit",
	async () => {
		const lockfile = "# yarn lockfile v1\n";
		const edited = `${lockfile}# edited\n`;
		const verdict = await editedCheck(
			"yarn.lock",
			"yarn",
			{
				"package.json": '{ "name": "app", "version": "1.0.0" }\n',
				".yarnrc": 'yarn-path "./tools/yarn.cjs"\n',
				"tools/package.json": '{ "name": "tools", "version": "1.0.0" }\n',
				"tools/yarn.cjs": "process.exit(3)\n",
				"yarn.lock": lockfile,
			},
			{
				"package.json":
					'{ "name": "app", "version": "1.0.0", "dependencies": { "tools": "file:tools" } }\n',
				"tools/yarn.cjs": `require("node:fs").writeFileSync("yarn.lock", ${JSON.stringify(edited)})\n`,
				"yarn.lock": edited,
			},
		);
		expect(verdict?.message).toContain("could not check that yarn wrote");
	},
);

test.skipIf(Bun.which("yarn") === null)(
	"a yarn-path release does not load files beside it from the working copy",
	async () => {
		const lockfile = "# yarn lockfile v1\n";
		const edited = `${lockfile}# edited\n`;
		const verdict = await editedCheck(
			"yarn.lock",
			"yarn",
			{
				"package.json": '{ "name": "app", "version": "1.0.0" }\n',
				".yarnrc": 'yarn-path "./tools/yarn.cjs"\n',
				"tools/package.json": '{ "name": "tools", "version": "1.0.0" }\n',
				"tools/yarn.cjs": 'require("./cli.cjs")\n',
				"tools/cli.cjs": "process.exit(3)\n",
				"yarn.lock": lockfile,
			},
			{
				"package.json":
					'{ "name": "app", "version": "1.0.0", "dependencies": { "tools": "file:tools" } }\n',
				"tools/cli.cjs": `require("node:fs").writeFileSync("yarn.lock", ${JSON.stringify(edited)})\n`,
				"yarn.lock": edited,
			},
		);
		expect(verdict?.message).toContain("could not check that yarn wrote");
	},
);

test.each([
	'yarn-path: "./"',
	'yarn-path:"./"',
	"yarn-path ./ # the release",
	'yarnPath "./"',
	"yarnPath: ./",
	'"yarnPath": "./"',
	'"yarn-path": ./',
])("a .yarnrc line %p names the yarn-path", async (line) => {
	const lockfile = "# yarn lockfile v1\n";
	const verdict = await editedCheck(
		"yarn.lock",
		"yarn",
		{
			"package.json": '{ "name": "app", "version": "1.0.0" }\n',
			".yarnrc": `${line}\n`,
			"yarn.lock": lockfile,
		},
		{ "yarn.lock": `${lockfile}\n` },
	);
	expect(verdict?.message).toContain("that is not one file in the repo");
});

test.each([
	"yarn-path './tools/yarn.cjs'",
	"--yarn-path ./tools/yarn.cjs",
	'yarn-path "./a.cjs" "./b.cjs"',
])("a .yarnrc line %p the check cannot read is refused", async (line) => {
	const lockfile = "# yarn lockfile v1\n";
	const verdict = await editedCheck(
		"yarn.lock",
		"yarn",
		{
			"package.json": '{ "name": "app", "version": "1.0.0" }\n',
			".yarnrc": `${line}\n`,
			"yarn.lock": lockfile,
		},
		{ "yarn.lock": `${lockfile}\n` },
	);
	expect(verdict?.message).toContain(
		"has a line about yarn-path that cagr cannot read",
	);
});

test.each([
	[".npmrc", "global-pnpmfile=tools/g.cjs\n"],
	["pnpm-workspace.yaml", "globalPnpmfile: tools/g.cjs\n"],
])("a global pnpmfile in %s is refused: %p", async (config, text) => {
	const lockfile = "lockfileVersion: '9.0'\n";
	const verdict = await editedCheck(
		"pnpm-lock.yaml",
		"pnpm",
		{
			"package.json": '{ "name": "app" }\n',
			[config]: text,
			"pnpm-lock.yaml": lockfile,
		},
		{ "pnpm-lock.yaml": `${lockfile}# edited\n` },
	);
	expect(verdict?.message).toContain(
		`The committed ${config} sets a global pnpmfile`,
	);
});

test("a packageManager a human set but did not commit asks for a commit", async () => {
	const lockfile = "lockfileVersion: '9.0'\n";
	const verdict = await editedCheck(
		"pnpm-lock.yaml",
		"pnpm",
		{ "package.json": '{ "name": "app" }\n', "pnpm-lock.yaml": lockfile },
		{
			"package.json": '{ "name": "app", "packageManager": "pnpm@11.22.0" }\n',
			"pnpm-lock.yaml": `${lockfile}# edited\n`,
		},
	);
	expect(verdict?.message).toContain(
		"is pnpm@11.22.0, and in the last commit unset",
	);
	expect(verdict?.message).toContain("ask the user to commit it");
});

test("a pnpmfile that loads a package Bun bundles but Node does not is not run", async () => {
	const lockfile = "lockfileVersion: '9.0'\n";
	const verdict = await editedCheck(
		"pnpm-lock.yaml",
		"pnpm",
		{
			"package.json": '{ "name": "app" }\n',
			".pnpmfile.cjs":
				"const { fetch } = require('undici')\nmodule.exports = {}\n",
			"pnpm-lock.yaml": lockfile,
		},
		{ "pnpm-lock.yaml": `${lockfile}# edited\n` },
	);
	expect(verdict?.message).toContain(
		"could not prove that .pnpmfile.cjs loads only Node built-ins",
	);
});

test("a pnpmfile a git clean filter makes look committed is refused", async () => {
	const lockfile = "lockfileVersion: '9.0'\n";
	const verdict = await editedCheck(
		"pnpm-lock.yaml",
		"pnpm",
		{
			"package.json": '{ "name": "app" }\n',
			".pnpmfile.cjs": "module.exports = {}\n",
			"pnpm-lock.yaml": lockfile,
		},
		{
			".gitattributes": ".pnpmfile.cjs filter=keep\n",
			".pnpmfile.cjs":
				"module.exports = { hooks: { readPackage: (pkg) => pkg } }\n",
			"pnpm-lock.yaml": `${lockfile}# edited\n`,
		},
		(repo) =>
			repo.git(
				"config",
				"filter.keep.clean",
				"git cat-file blob HEAD:.pnpmfile.cjs",
			),
	);
	expect(verdict?.message).toContain(
		".pnpmfile.cjs differs from the last commit",
	);
});

test("a yarn-path that is not one file in the repo is refused", async () => {
	const lockfile = "# yarn lockfile v1\n";
	const verdict = await editedCheck(
		"yarn.lock",
		"yarn",
		{
			"package.json": '{ "name": "app", "version": "1.0.0" }\n',
			".yarnrc": 'yarn-path "./"\n',
			"yarn.lock": lockfile,
		},
		{ "yarn.lock": `${lockfile}\n` },
	);
	expect(verdict?.message).toContain("that is not one file in the repo");
});

test("an absolute yarn-path into the checkout is refused", async () => {
	const lockfile = "# yarn lockfile v1\n";
	const verdict = await editedCheck(
		"yarn.lock",
		"yarn",
		(root) => ({
			"package.json": '{ "name": "app", "version": "1.0.0" }\n',
			".yarnrc": `yarn-path "${join(root, "tools/yarn.cjs")}"\n`,
			"tools/yarn.cjs": "process.exit(3)\n",
			"yarn.lock": lockfile,
		}),
		{ "yarn.lock": `${lockfile}\n` },
	);
	expect(verdict?.message).toContain("by its absolute path in this checkout");
});

test.each([
	[
		"a core module",
		"const p = require('node:path')\nmodule.exports = {}",
		true,
	],
	[
		"static imports of core modules",
		"import { a } from 'node:fs'\nimport 'path'",
		true,
	],
	[
		"an ES module export",
		"import { basename } from 'node:path'\nexport default { hooks: {} }",
		true,
	],
	["require.resolve of a core module", "require.resolve('node:fs')", false],
	["a require word in a comment", "// pnpm does not require this peer", false],
	["an import key", "const e = { import: './a.mjs' }", false],
	[
		"a load after a regex that ends in //",
		"if (/^https?:\\/\\//.test(url)) pkg = require('./rewrite')(pkg)",
		false,
	],
	[
		"a computed load after a regex holding a quote",
		"s.replace(/'/g, ''); require(name); x = 'y'",
		false,
	],
	["require.call", "require.call(null, './x')", false],
	["require.bind", "const r = require.bind(null); r('./x')", false],
	["optional call", "require?.('./x')", false],
	["a comment before the paren", "require/**/('./x')", false],
	["a line comment before the paren", "require // c\n('./x')", false],
	["require passed on", "load(require, './x')", false],
	["require in an array", "[require][0]('./x')", false],
	["an identifier escape", "\\u0072equire('./x')", false],
	["the wrapper arguments", "arguments[1]('./x')", false],
	["a computed member of module", "module['req' + 'uire']('./x')", false],
	["module.constructor", "module.constructor._load('./x')", false],
	["eval", "eval(code)", false],
	[
		"child_process",
		"require('node:child_process').execSync('node ./x')",
		false,
	],
	[
		"createRequire",
		"require('node:module').createRequire(__filename)('x')",
		false,
	],
	["a package Bun bundles", "import x from 'undici'", false],
	["a re-export", "export * from './x'", false],
	["a member require call", "module.require('semver')", false],
	[
		"a require word inside an import binding list",
		"var from = 0, o = {}\no.export\nclass A extends require {}\nfrom\n'fs'\nObject.getPrototypeOf(A)('./x')",
		false,
	],
	...["require", "Function"].map(
		(word) =>
			[
				`${word} inside a binding list at a statement start`,
				`var from = 0, o = {}\no.\nexport\nclass A extends ${word} {}\nfrom\n'fs'\nObject.getPrototypeOf(A)('./x')`,
				false,
			] as const,
	),
	["a template literal load", "require(`./x`)", false],
	["Function", "Function('return 1')()", false],
	["globalThis", "globalThis.process", false],
	["WebAssembly", "WebAssembly.instantiate(bytes)", false],
	["mainModule", "process.mainModule", false],
	["execve", "process.execve('/bin/sh')", false],
	["dlopen", "process.dlopen(m, './x.node')", false],
	["binding", "process.binding('fs')", false],
	["an optional computed member of module", "module?.['x']", false],
	[
		"getBuiltinModule",
		"process.getBuiltinModule('node:child_process').execSync('node ./x')",
		false,
	],
	[
		"createRequire from getBuiltinModule",
		"process.getBuiltinModule('module').createRequire(__filename)('./x')",
		false,
	],
	["_linkedBinding", "process._linkedBinding('x')", false],
	["a computed member of process", "process['getBuiltin' + 'Module']", false],
	["process in parentheses", "(process)['x']", false],
	["process passed on", "Reflect.get(process, 'x')", false],
	["a comment between module and a bracket", "module/**/['x']('./x')", false],
	["module in parentheses", "(module)['x']('./x')", false],
	["module given another name", "const m = module; m['x']", false],
	[
		"process.env, a module field and module.exports",
		"if (process.env.CI && pkg.type === 'module') pkg.module = 'x'\nmodule . exports = { hooks: {} }",
		true,
	],
	...["vm", "worker_threads", "cluster", "inspector", "repl", "wasi"].map(
		(name) => [`the ${name} module`, `require('node:${name}')`, false] as const,
	),
])("a pnpmfile with %s loads only built-ins: %p", (_, code, expected) => {
	expect(builtinsOnly(code)).toBe(expected);
});

test("a pnpmfile that differs from the commit by more than CRLF line ends is refused", async () => {
	const lockfile = "lockfileVersion: '9.0'\n";
	const committed = "module.exports = {}\n";
	const verdict = await editedCheck(
		"pnpm-lock.yaml",
		"pnpm",
		{
			"package.json": '{ "name": "app" }\n',
			".pnpmfile.cjs": committed,
			"pnpm-lock.yaml": lockfile,
		},
		{
			".pnpmfile.cjs": `\uFEFF${committed.replaceAll("\n", "\r\n")}`,
			"pnpm-lock.yaml": `${lockfile}# edited\n`,
		},
	);
	expect(verdict?.message).toContain(
		".pnpmfile.cjs differs from the last commit",
	);
});

test.each([
	[
		"two yarn-path lines that disagree",
		'yarn-path "./a.cjs"\nyarn-path "./b.cjs"\n',
	],
	["a quoted yarn-path key", '"yarn-path" "./"\n'],
])("a .yarnrc with %s is refused", async (_, yarnrc) => {
	const lockfile = "# yarn lockfile v1\n";
	const verdict = await editedCheck(
		"yarn.lock",
		"yarn",
		{
			"package.json": '{ "name": "app", "version": "1.0.0" }\n',
			".yarnrc": yarnrc,
			"yarn.lock": lockfile,
		},
		{ "yarn.lock": `${lockfile}\n` },
	);
	expect(verdict?.message).toContain("that is not one file in the repo");
});

test.each([
	[".npmrc", "pnpmfile=tools/hooks.cjs\n"],
	[".npmrc", 'pnpmfile = "./tools/hooks.cjs"\n'],
	["pnpm-workspace.yaml", "packages: []\npnpmfile: tools/hooks.cjs\n"],
])("a pnpmfile named in %s gets the same checks: %p", async (config, text) => {
	const lockfile = "lockfileVersion: '9.0'\n";
	const files = {
		"package.json": '{ "name": "app" }\n',
		[config]: text,
		"tools/hooks.cjs":
			"const hooks = require('./more')\nmodule.exports = { hooks }\n",
		"pnpm-lock.yaml": lockfile,
	};
	const edited = { "pnpm-lock.yaml": `${lockfile}# edited\n` };
	expect(
		(await editedCheck("pnpm-lock.yaml", "pnpm", files, edited))?.message,
	).toContain("could not prove that tools/hooks.cjs loads only Node built-ins");
	expect(
		(
			await editedCheck("pnpm-lock.yaml", "pnpm", files, {
				...edited,
				"tools/hooks.cjs": "module.exports = {}\n",
			})
		)?.message,
	).toContain("tools/hooks.cjs differs from the last commit");
});

test.each([
	[".npmrc", "pnpmfile=../hooks.cjs\n"],
	[".npmrc", "pnpmfile=/etc/hooks.cjs\n"],
	[".npmrc", `pnpmfile=$${"{"}HOME}/hooks.cjs\n`],
	["pnpm-workspace.yaml", "pnpmfile: ['../hooks.cjs']\n"],
])("a pnpmfile in %s outside the repo is refused: %p", async (config, text) => {
	const lockfile = "lockfileVersion: '9.0'\n";
	const verdict = await editedCheck(
		"pnpm-lock.yaml",
		"pnpm",
		{
			"package.json": '{ "name": "app" }\n',
			[config]: text,
			"pnpm-lock.yaml": lockfile,
		},
		{ "pnpm-lock.yaml": `${lockfile}# edited\n` },
	);
	expect(verdict?.message).toContain(
		`The committed ${config} sets pnpmfile to`,
	);
	expect(verdict?.message).toContain("not a path inside the repo");
});
