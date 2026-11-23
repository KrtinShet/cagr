import { existsSync, lstatSync, realpathSync } from "node:fs";
import {
	cp,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	posix,
	relative,
	sep,
} from "node:path";
import type { Stack } from "../config/schema";
import { insideRoot, matchesGlob } from "../paths";
import { run, shellQuote } from "../run";

export type LockfileStack = Pick<
	Stack,
	"paths" | "exclude_paths" | "package_manager"
>;

type Writer = "bun" | "pnpm" | "npm" | "yarn";

/** What each JavaScript lockfile is written by. bun.lockb is binary and current bun no longer writes it. */
const writers: Record<string, Writer> = {
	"bun.lock": "bun",
	"pnpm-lock.yaml": "pnpm",
	"package-lock.json": "npm",
	"yarn.lock": "yarn",
};

const workspaceFile = "pnpm-workspace.yaml";
/** The pnpm-workspace.yaml keys a normal change edits. Every other key is a pnpm setting. */
const workspaceKeys = new Set(["packages", "catalog", "catalogs"]);
const pnpmfiles = [".pnpmfile.cjs", ".pnpmfile.mjs"];
/** Config that picks the registry, the cache or code the manager runs. It comes from the starting commit, since the agent can write the working copy. */
const configs = new Set([".npmrc", "bunfig.toml", ".yarnrc"]);
const configDirs = [".yarn/releases/"];
/** Package caches under the home folder. The check links them into its own home, so offline resolution finds packages while config under the real home stays out. */
const homeCaches = [
	".bun/install/cache",
	".npm",
	".cache/pnpm",
	".cache/yarn",
	"Library/Caches/pnpm",
	"Library/Caches/Yarn",
	"Library/pnpm/store",
];
const localCaches = ["pnpm/store", "pnpm-cache", "npm-cache", "Yarn/Cache"];
const tempPrefix = "cagr-lockfile-";
const dependencyFields = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies",
	"overrides",
	"resolutions",
	"patchedDependencies",
];

const yarnBerry =
	"cagr checks Yarn 1 lockfiles only. Yarn 2 and later can load plugins and releases from outside the repo, so cagr does not run them. Restore the file and ask the user to run the yarn command.";

export const isLockfile = (path: string) =>
	Object.hasOwn(writers, basename(path));

/** Null message: the package manager wrote this lockfile. */
export type LockfileVerdict = { message: string | null };

/** The covering stack's JavaScript manager, preferring the lockfile's own writer when several stacks cover it. */
function managerFor(stacks: LockfileStack[], path: string, writer: Writer) {
	const javascript: string[] = Object.values(writers);
	const managers = stacks
		.filter(
			(stack) =>
				stack.paths.some((glob) => matchesGlob(glob, path)) &&
				!stack.exclude_paths?.some((glob) => matchesGlob(glob, path)),
		)
		.map((stack) => stack.package_manager)
		.filter((manager) => manager !== null && javascript.includes(manager));
	return managers.includes(writer) ? writer : managers[0];
}

type Command = {
	argv: string[];
	env?: Record<string, string>;
	/** Yarn reads rc files from every parent folder, and the temp folder's parents are writable. */
	yarnrc?: boolean;
};

/** The command, and its environment, that makes the manager rewrite only the lockfile without the network or scripts. The starting lockfile, when there is one, picks the Yarn major version, since the current one is under check. */
function command(manager: Writer, lockfile: Uint8Array): Command | null {
	switch (manager) {
		case "bun":
			return {
				argv: ["bun", "install", "--lockfile-only", "--ignore-scripts"],
			};
		case "pnpm":
			return {
				argv: [
					"pnpm",
					"install",
					"--lockfile-only",
					"--offline",
					"--ignore-scripts",
					"--no-frozen-lockfile",
					"--config.manage-package-manager-versions=false",
					"--config.package-manager-strict=false",
				],
			};
		case "npm":
			return {
				argv: [
					"npm",
					"install",
					"--package-lock-only",
					"--offline",
					"--ignore-scripts",
					"--no-audit",
					"--no-fund",
				],
			};
		case "yarn":
			// Yarn 2 and later load plugins and releases named in rc files from any parent folder, so cagr does not run them.
			if (/^__metadata:/m.test(new TextDecoder().decode(lockfile))) return null;
			// Yarn 1 has no lockfile-only mode. It installs into the temp copy.
			return {
				argv: [
					"yarn",
					"install",
					"--offline",
					"--ignore-scripts",
					"--ignore-engines",
					"--non-interactive",
					"--no-bin-links",
					"--no-progress",
					"--no-default-rc",
				],
				yarnrc: true,
			};
	}
}

function localRefs(manifest: string, text: string): string[] {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return [];
	}
	const refs: string[] = [];
	const visit = (value: unknown, field: string) => {
		if (typeof value === "string") {
			const local = /^(?:file|link|portal):(.+)$/.exec(value)?.[1];
			const spec = local ?? value;
			if (
				!isAbsolute(spec) &&
				(local || field === "patchedDependencies" || /^\.{1,2}\//.test(spec))
			)
				refs.push(join(dirname(manifest), spec));
		} else if (value && typeof value === "object")
			for (const inner of Object.values(value)) visit(inner, field);
	};
	const scopes = [json, (json as { pnpm?: unknown } | null)?.pnpm];
	for (const scope of scopes)
		if (scope && typeof scope === "object")
			for (const field of dependencyFields)
				visit((scope as Record<string, unknown>)[field], field);
	return refs;
}

/** A verdict for a change a human must make. Its message is the whole reason. */
class Refusal extends Error {}

/** A git object's bytes, read without a text decode so a BOM, CRLF or invalid UTF-8 survives. Null when git cannot read it. */
export async function gitBlob(root: string, object: string, timeoutMs: number) {
	const child = Bun.spawn(["git", "cat-file", "blob", object], {
		cwd: root,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "ignore",
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
		timeout: Math.max(1, timeoutMs),
		killSignal: "SIGKILL",
	});
	const [bytes, code] = await Promise.all([
		new Response(child.stdout).bytes(),
		child.exited,
	]);
	return code === 0 ? bytes : null;
}

const decode = (bytes: Uint8Array | null) =>
	bytes === null ? null : new TextDecoder().decode(bytes);

const unquote = (key: string) =>
	key.startsWith('"')
		? (JSON.parse(key) as string)
		: key.startsWith("'")
			? key.slice(1, -1).replaceAll("''", "'")
			: key.trim();

/** Splits YAML into its top-level keys with their lines, or null for a layout this cannot split, such as a flow mapping. */
function topLevel(text: string) {
	const sections: { key: string; text: string }[] = [];
	for (const line of text.replace(/^\uFEFF/, "").split(/(?<=\n)/)) {
		const current = sections.at(-1);
		if (/^(\s|-(\s|$)|#)/.test(line) || line.trim() === "") {
			if (current) current.text += line;
			else if (line.trim() && !line.startsWith("#")) return null;
			continue;
		}
		if (/^---\s*$/.test(line) && !current) continue;
		const key =
			/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#:{}[\],&*!|>%@`][^:#]*?)\s*:(?:\s|$)/.exec(
				line,
			)?.[1];
		if (key === undefined) return null;
		sections.push({
			key: unquote(key),
			text: line,
		});
	}
	return sections;
}

/** The pnpm settings in a pnpm-workspace.yaml: every key but the package list and catalogs. */
function workspaceSettings(path: string, text: string | null) {
	let data: unknown;
	try {
		data = text === null ? {} : (Bun.YAML.parse(text) ?? {});
	} catch (error) {
		throw new Error(`${path} is not valid YAML: ${(error as Error).message}`);
	}
	if (!data || typeof data !== "object" || Array.isArray(data))
		throw new Error(`${path} is not a YAML mapping.`);
	return JSON.stringify(
		sortKeys(
			Object.fromEntries(
				Object.entries(data).filter(([key]) => !workspaceKeys.has(key)),
			),
		),
	);
}

/**
 * The pnpm-workspace.yaml the check runs with: the package list and catalogs
 * from the working copy, every other key from the starting commit, which the
 * working copy must not change.
 */
function workspaceFor(path: string, work: string | null, start: string | null) {
	if (workspaceSettings(path, work) !== workspaceSettings(path, start))
		throw new Refusal(
			`${path} differs from the last commit in pnpm settings other than packages, catalog and catalogs. Those settings pick the store, overrides and which packages run build scripts, so cagr uses only committed ones. If the turn changed them, restore them; if a human did, ask the user to commit them. Then stop again.`,
		);
	if (work === null || work === start) return work;
	const working = topLevel(work);
	const starting = start === null ? [] : topLevel(start);
	const keys = working?.map((section) => section.key) ?? [];
	if (!working || !starting || new Set(keys).size !== keys.length)
		throw new Refusal(
			`cagr reads ${path} as one block of top-level keys, each once. Write it that way, or restore it and ask the user to make the change.`,
		);
	return [
		...starting.filter((section) => !workspaceKeys.has(section.key)),
		...working.filter((section) => workspaceKeys.has(section.key)),
	]
		.map((section) =>
			section.text.endsWith("\n") ? section.text : `${section.text}\n`,
		)
		.join("");
}

/** Copies what the package manager reads for the lockfile at `path`: manifests, its config and local packages. */
async function copyInputs(
	root: string,
	head: string | null,
	path: string,
	target: string,
	deadline: number,
) {
	const project = posix.dirname(path);
	const inProject = (file: string) =>
		project === "." ? file : file.slice(project.length + 1);
	const timeoutMs = () => Math.max(1, Math.floor(deadline - performance.now()));
	const gitRun = async (args: string[]) => {
		const result = await run(["git", ...args], root, {
			timeoutMs: timeoutMs(),
		});
		if (!result.ok)
			throw new Error(`git ${args[0]} failed: ${result.output.trim()}`);
		return result.stdout;
	};
	const committed = head
		? (
				await gitRun([
					"ls-tree",
					"-r",
					"-z",
					"--name-only",
					head,
					"--",
					project,
				])
			)
				.split("\0")
				.filter(Boolean)
		: [];
	const inHead = new Set(committed);
	/** A file's bytes in the starting commit, or null when it has none. */
	const fromHead = async (file: string) => {
		if (!head) return null;
		const bytes = await gitBlob(root, `${head}:${file}`, timeoutMs());
		if (bytes === null && inHead.has(file))
			throw new Error(`git could not read ${file} from ${head}.`);
		return bytes;
	};
	const listed = await run(
		[
			"git",
			"ls-files",
			"-z",
			"--cached",
			"--others",
			"--exclude-standard",
			"--",
			project,
		],
		root,
		{ timeoutMs: timeoutMs() },
	);
	if (!listed.ok) throw new Error(`git ls-files failed: ${listed.output}`);
	const files = listed.stdout
		.split("\0")
		.filter(
			(file) =>
				basename(file) === "package.json" ||
				inProject(file).startsWith(".yarn/patches/") ||
				inProject(file).startsWith("patches/"),
		);
	const refs = new Set<string>();
	for (const file of files) {
		const source = join(root, file);
		if (!existsSync(source) || lstatSync(source).isSymbolicLink()) continue;
		await mkdir(dirname(join(target, file)), { recursive: true });
		await cp(source, join(target, file));
		if (basename(file) === "package.json")
			for (const ref of localRefs(file, await readFile(source, "utf8")))
				refs.add(ref);
	}
	const workspaces = new Set(
		[...listed.stdout.split("\0"), ...committed].filter(
			(file) => basename(file) === workspaceFile,
		),
	);
	for (const file of workspaces) {
		const source = join(root, file);
		const work =
			existsSync(source) && !lstatSync(source).isSymbolicLink()
				? await readFile(source, "utf8")
				: null;
		const text = workspaceFor(file, work, decode(await fromHead(file)));
		if (text === null) continue;
		await mkdir(dirname(join(target, file)), { recursive: true });
		await writeFile(join(target, file), text);
	}
	for (const ref of refs) {
		const source = join(root, ref);
		if (insideRoot(root, source) === null || !existsSync(source)) continue;
		await cp(source, join(target, ref), {
			recursive: true,
			filter: (from) => {
				if (performance.now() > deadline)
					throw new Error(`Copying the local package ${ref} ran out of time.`);
				// A copied symlink could send later writes outside the temp folder.
				if (lstatSync(from).isSymbolicLink()) return false;
				// Config, lockfiles and pnpmfiles come from the starting commit and the turn's baseline, never a local package copy.
				const name = basename(from).toLowerCase();
				return !(
					/^(node_modules|\.git|\.yarn)$/.test(name) ||
					configs.has(name) ||
					pnpmfiles.includes(name) ||
					name === workspaceFile ||
					Object.hasOwn(writers, name)
				);
			},
		});
	}
	// Written last, so no copy above can replace it, even under another letter case.
	for (const file of committed)
		if (
			configs.has(basename(file)) ||
			configDirs.some((dir) => inProject(file).startsWith(dir))
		) {
			await mkdir(dirname(join(target, file)), { recursive: true });
			await writeFile(join(target, file), (await fromHead(file)) ?? "");
		}
	const yarnrc = decode(await fromHead(posix.join(project, ".yarnrc")));
	const releases = [
		...(yarnrc ?? "").matchAll(
			/^\s*(?:yarn-path|"yarn-path")\s+(?:"([^"]*)"|(\S+))/gm,
		),
	].map((match) => match[1] ?? match[2] ?? "");
	// Yarn 1 runs the release the committed .yarnrc names, so it must come from the commit too.
	if (releases.length) {
		const release = releases[0] ?? "";
		const outside = relative(
			root,
			isAbsolute(release) && existsSync(release)
				? realpathSync(release)
				: release,
		)
			.split(sep)
			.join("/");
		if (
			isAbsolute(release) &&
			!(outside === ".." || outside.startsWith("../") || isAbsolute(outside))
		)
			throw new Refusal(
				`The committed .yarnrc names yarn-path ${release} by its absolute path in this checkout, where Yarn would run the working copy. Make it relative to the .yarnrc in a commit, or restore the lockfile and ask the user to run the yarn command.`,
			);
		const file = posix.normalize(posix.join(project, release));
		if (
			new Set(releases).size > 1 ||
			(!isAbsolute(release) &&
				(file === ".." ||
					file.startsWith("../") ||
					file.endsWith("/") ||
					file === "." ||
					file === project))
		)
			throw new Refusal(
				`The committed .yarnrc names a yarn-path, ${release}, that is not one file in the repo, so the check cannot take it from the commit. Restore the lockfile and ask the user to run the yarn command.`,
			);
		// A release outside the checkout is part of the machine, like the yarn on PATH.
		if (!isAbsolute(release)) {
			const bytes = await fromHead(file);
			await rm(join(target, file), { force: true, recursive: true });
			if (bytes) {
				await mkdir(dirname(join(target, file)), { recursive: true });
				await writeFile(join(target, file), bytes);
			}
		}
	}
	return fromHead;
}

/** The packageManager Corepack picks for `project`: the nearest package.json at or above it that sets one. */
async function packageManagerOf(
	project: string,
	read: (file: string) => Promise<string | null>,
) {
	for (let dir = project; ; dir = posix.dirname(dir)) {
		const text = await read(posix.join(dir, "package.json"));
		try {
			const value =
				text === null ? undefined : JSON.parse(text)?.packageManager;
			if (typeof value === "string") return value;
		} catch {}
		if (dir === ".") return null;
	}
}

/** The working copy's package.json text, or null for none or a symlink. */
async function workingText(root: string, file: string) {
	const source = join(root, file);
	return existsSync(source) && !lstatSync(source).isSymbolicLink()
		? readFile(source, "utf8")
		: null;
}

/** The folder pnpm treats as the workspace root: the nearest one in the copy with a pnpm-workspace.yaml, else the lockfile's own. */
function workspaceRoot(repo: string, project: string) {
	for (let dir = project; dir.startsWith(repo); dir = dirname(dir)) {
		if (existsSync(join(dir, workspaceFile))) return dir;
		if (dir === repo) break;
	}
	return project;
}

/** Node core modules a pnpmfile may load. A fixed list, since Bun lists modules Node resolves from disk, and without those that run other code or files, such as child_process, vm and module. */
const coreModules = new Set(
	"assert assert/strict async_hooks buffer console constants crypto dgram diagnostics_channel dns dns/promises domain events fs fs/promises http http2 https net os path path/posix path/win32 perf_hooks process punycode querystring readline readline/promises stream stream/consumers stream/promises stream/web string_decoder sys timers timers/promises tls trace_events tty url util util/types v8 zlib".split(
		" ",
	),
);

/**
 * Whether a pnpmfile loads only Node core modules. Anything else resolves to
 * files in the temp folder or its parents, which the agent can write. JavaScript
 * has too many ways to reach `require` for a pattern to list, so every
 * `require` or `import` word must be a direct load of a core module by a
 * literal name, wherever it appears, and the other ways to load or run code
 * are refused. That also refuses those words in comments and object keys.
 */
/** Words that load or run code other than through a literal core load. */
const refusedWords =
	"require|import|eval|Function|constructor|arguments|globalThis|WebAssembly|mainModule|_load|execve|dlopen|binding";

const literalLoads = new RegExp(
	[
		`\\brequire\\s*\\(\\s*(["'])([^"'\\n]+)\\1\\s*\\)`,
		`\\bimport\\s*\\(\\s*(["'])([^"'\\n]+)\\3\\s*\\)`,
		// A static import or export at a statement start, whose binding list holds no refused word to erase.
		`(?:^|[;}\\n])\\s*(?:import|export)\\s+(?:(?:(?!\\b(?:${refusedWords}|export)\\b)[\\w$*{},\\s])+?\\s+from\\s+)?(["'])([^"'\\n]+)\\5`,
	].join("|"),
	"g",
);

const refused = new RegExp(
	`\\b(?:${refusedWords})\\b|\\\\u|\\bmodule\\s*(?:\\?\\.\\s*)?\\[|\\bfrom\\s*["'\`]`,
);

export function builtinsOnly(text: string) {
	for (const match of text.matchAll(literalLoads))
		if (
			!coreModules.has(
				(match[2] ?? match[4] ?? match[6] ?? "").replace(/^node:/, ""),
			)
		)
			return false;
	return !refused.test(text.replace(literalLoads, " "));
}

/**
 * A pnpmfile runs inside pnpm and changes the lockfile, so the check runs it
 * only when it matches the starting commit, byte for byte or as a CRLF
 * checkout of it, and loads only Node built-ins.
 */
async function copyPnpmfiles(
	root: string,
	workspace: string,
	target: string,
	fromHead: (file: string) => Promise<Uint8Array | null>,
) {
	for (const name of pnpmfiles) {
		const file = posix.join(workspace, name);
		const source = join(root, file);
		const work = existsSync(source)
			? new Uint8Array(await readFile(source))
			: null;
		const start = await fromHead(file);
		const committed = decode(start);
		// Only a checkout with CRLF line ends may differ, since Git attributes and filters are agent-writable.
		const checkedOut =
			work !== null &&
			start !== null &&
			(Buffer.from(work).equals(Buffer.from(start)) ||
				(!start.includes(13) &&
					Buffer.from(work).equals(
						Buffer.from(
							Buffer.from(start).toString("latin1").replaceAll("\n", "\r\n"),
							"latin1",
						),
					)));
		if ((work !== null || start !== null) && !checkedOut)
			throw new Refusal(
				`${file} differs from the last commit. A pnpmfile runs inside pnpm and can rewrite any dependency, so cagr runs only a committed one. If the turn changed it, restore it; if a human did, ask the user to commit it. Then stop again.`,
			);
		if (!work || committed === null) continue;
		if (!builtinsOnly(committed))
			throw new Refusal(
				`cagr could not prove that ${file} loads only Node built-ins. In the check any other module would come from the temp folder, which the agent can write, so cagr does not run it. Restore the lockfile and ask the user to run the pnpm command.`,
			);
		await writeFile(join(target, file), work);
	}
}

/**
 * Settings that keep the manager to the config of the starting commit: a home
 * folder of its own holding links to the real package caches, empty user and
 * global npm config, and no download of the manager itself.
 */
async function isolatedEnv(home: string) {
	const env = process.env;
	const real = env.HOME ?? homedir();
	const local = env.LOCALAPPDATA ?? join(real, "AppData/Local");
	const links = [
		...homeCaches.map((path) => [join(real, path), join(home, path)]),
		[
			join(env.XDG_DATA_HOME ?? join(real, ".local/share"), "pnpm/store"),
			join(home, ".local/share/pnpm/store"),
		],
		...localCaches.map((path) => [
			join(local, path),
			join(home, "AppData/Local", path),
		]),
	];
	for (const [from = "", to = ""] of links)
		if (existsSync(from)) {
			await mkdir(dirname(to), { recursive: true });
			await symlink(from, to, "junction");
		}
	await writeFile(join(home, ".npmrc"), "");
	await writeFile(join(home, "npmrc"), "");
	return {
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_DATA_HOME: join(home, ".local/share"),
		APPDATA: join(home, "AppData/Roaming"),
		LOCALAPPDATA: join(home, "AppData/Local"),
		npm_config_userconfig: join(home, ".npmrc"),
		npm_config_globalconfig: join(home, "npmrc"),
		COREPACK_HOME:
			env.COREPACK_HOME ??
			join(
				env.XDG_CACHE_HOME ??
					(process.platform === "win32" ? local : join(real, ".cache")),
				"node/corepack",
			),
		COREPACK_ENABLE_NETWORK: "0",
		COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
		COREPACK_ENV_FILE: "0",
	};
}

/** Removes temp folders that a killed hook left behind. */
async function removeStale() {
	const cutoff = Date.now() - 3_600_000;
	const names = await readdir(tmpdir()).catch(() => []);
	await Promise.all(
		names
			.filter((name) => name.startsWith(tempPrefix))
			.map(async (name) => {
				const folder = join(tmpdir(), name);
				const info = await lstat(folder).catch(() => null);
				if (info?.isDirectory() && info.mtimeMs < cutoff)
					await rm(folder, { recursive: true, force: true }).catch(() => {});
			}),
	);
}

async function regenerate(
	manager: Writer,
	spec: Command,
	root: string,
	head: string | null,
	path: string,
	lockfile: Uint8Array | null,
	deadline: number,
) {
	await removeStale();
	// The real path, since npm reads a --prefix through a symlinked tmpdir as another folder.
	const folder = await realpath(await mkdtemp(join(tmpdir(), tempPrefix)));
	try {
		const repo = join(folder, "repo");
		const home = join(folder, "home");
		await mkdir(home);
		const fromHead = await copyInputs(root, head, path, repo, deadline);
		const project = posix.dirname(path);
		const pinned = await packageManagerOf(project, async (file) =>
			decode(await fromHead(file)),
		);
		const working = await packageManagerOf(project, (file) =>
			workingText(root, file),
		);
		if (pinned !== working)
			throw new Refusal(
				`The packageManager field in package.json is ${working ?? "unset"}, and in the last commit ${pinned ?? "unset"}. It picks the version Corepack runs, so cagr uses only a committed one. If the turn changed it, restore it; if a human did, ask the user to commit it. Then stop again.`,
			);
		if (manager === "yarn" && /^yarn@(?:[2-9]|\d\d)/.test(pinned ?? ""))
			throw new Refusal(yarnBerry);
		// Managers look in parent folders for a workspace root, and Corepack for a packageManager. bun and Yarn stop at this one, which has no packages.
		await writeFile(
			join(folder, "package.json"),
			JSON.stringify({
				private: true,
				workspaces: [],
				...(pinned ? { packageManager: pinned } : {}),
			}),
		);
		const file = join(repo, path);
		if (lockfile) await writeFile(file, lockfile);
		const folderOf = dirname(file);
		const argv = [...spec.argv];
		const env: Record<string, string> = {
			...(await isolatedEnv(home)),
			// With no packageManager in the repo, Corepack would keep looking above the temp folder.
			...(pinned ? {} : { COREPACK_ENABLE_PROJECT_SPEC: "0" }),
			...spec.env,
		};
		if (manager === "npm") argv.push("--prefix", folderOf);
		if (manager === "pnpm") {
			const workspace = workspaceRoot(repo, folderOf);
			const relativeRoot =
				relative(repo, workspace).split(sep).join("/") || ".";
			env.NPM_CONFIG_WORKSPACE_DIR = workspace;
			await copyPnpmfiles(root, relativeRoot, repo, fromHead);
			const manifest = posix.join(relativeRoot, "package.json");
			const settings = (text: string | null) => {
				try {
					return JSON.stringify(
						sortKeys(text === null ? undefined : JSON.parse(text)?.pnpm),
					);
				} catch {
					return "";
				}
			};
			if (
				settings(await workingText(root, manifest)) !==
				settings(decode(await fromHead(manifest)))
			)
				throw new Refusal(
					`The pnpm field in ${manifest} differs from the last commit. It holds pnpm settings such as overrides and which packages run build scripts, so cagr uses only committed ones. If the turn changed it, restore it; if a human did, ask the user to commit it. Then stop again.`,
				);
		}
		if (spec.yarnrc && existsSync(join(folderOf, ".yarnrc")))
			argv.push("--use-yarnrc", join(folderOf, ".yarnrc"));
		const timeoutMs = Math.floor(deadline - performance.now());
		if (timeoutMs <= 0) throw new Error("No time was left to run it.");
		const result = await run(argv, folderOf, {
			timeoutMs,
			env,
			processGroup: true,
		});
		const shown = spec.argv.join(" ");
		if (result.timedOut)
			throw new Error(`\`${shown}\` did not finish in ${timeoutMs} ms.`);
		if (!result.ok)
			throw new Error(
				`\`${shown}\` failed: ${result.output.trim().split("\n").slice(-3).join(" ").slice(0, 400)}`,
			);
		return existsSync(file) ? new Uint8Array(await readFile(file)) : null;
	} finally {
		await rm(folder, { recursive: true, force: true });
	}
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, inner]) => [key, sortKeys(inner)]),
	);
}

/** Whether JSON or JSONC repeats a key in one object. A parser keeps the last copy, so a repeat could hide a hand edit. */
export function repeatsKey(text: string) {
	const objects: (Set<string> | null)[] = [];
	let previous = "";
	for (const [token] of text.matchAll(
		/"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\/|[{}[\]:,]/g,
	)) {
		if (token.startsWith("//") || token.startsWith("/*")) continue;
		if (token === "{") objects.push(new Set());
		else if (token === "[") objects.push(null);
		else if (token === "}" || token === "]") objects.pop();
		else if (token === ":" && previous.startsWith('"')) {
			const keys = objects.at(-1);
			const key = JSON.parse(previous) as string;
			if (keys?.has(key)) return true;
			keys?.add(key);
		}
		previous = token;
	}
	return false;
}

/** bun.lock and package-lock.json compare as data, since `bun add` writes keys in an order `bun install` later sorts. */
const parsers: Record<string, (text: string) => unknown> = {
	"bun.lock": (text) => Bun.JSONC.parse(text),
	"package-lock.json": (text) => JSON.parse(text),
};

/** Equal bytes, or equal JSON data with keys in any order and none repeated. */
function same(name: string, a: Uint8Array | null, b: Uint8Array | null) {
	if (a === null || b === null) return false;
	if (Buffer.from(a).equals(Buffer.from(b))) return true;
	const parse = parsers[name];
	if (!parse) return false;
	try {
		const texts = [a, b].map((bytes) => new TextDecoder().decode(bytes));
		if (texts.some(repeatsKey)) return false;
		const [left, right] = texts.map((text) =>
			JSON.stringify(sortKeys(parse(text))),
		);
		return left === right;
	} catch {
		return false;
	}
}

/**
 * Says whether the lockfile at `path` is what the stack's package manager
 * writes. The manager rewrites the starting lockfile against the current
 * manifests in a temp copy, so the versions and hashes it keeps come from the
 * starting lockfile and new ones come from its own resolution. Returns null
 * for files this check does not cover.
 */
export async function checkLockfile(options: {
	root: string;
	path: string;
	stacks: LockfileStack[];
	baseline: Uint8Array | null;
	/** The commit at the start of the turn, which supplies the manager config. */
	head: string | null;
	deadline: number;
}): Promise<LockfileVerdict | null> {
	const { root, head, path, stacks, baseline, deadline } = options;
	const writer = writers[basename(path)];
	if (!writer) return null;
	const manager = managerFor(stacks, path, writer);
	if (!manager)
		return {
			message: `cagr accepts a ${basename(path)} change only when a [[stack]] with package_manager covers ${path}. Ask the user to add one to the cagr config, or restore the file.`,
		};
	if (manager !== writer)
		return {
			message: `This part of the repo uses ${manager}, which does not write ${basename(path)}. Change dependencies with ${manager} add or remove instead.`,
		};
	const info = await lstat(join(root, path)).catch(() => null);
	if (!info?.isFile())
		return {
			message: `${path} is ${info ? "not a regular file" : "deleted"}. ${manager} writes its lockfile as a regular file, so restore it.`,
		};
	try {
		const current = new Uint8Array(await readFile(join(root, path)));
		const spec = command(writer, baseline ?? current);
		if (!spec)
			return {
				message: yarnBerry,
			};
		const rewritten = await regenerate(
			writer,
			spec,
			root,
			head,
			path,
			baseline,
			deadline,
		);
		if (same(basename(path), rewritten, current)) return { message: null };
		return {
			message: `This is not what ${manager} writes from the current manifests and the lockfile at the start of the turn, so it looks edited by hand. Change dependencies with ${manager} add or remove instead. If an update command changed versions without changing package.json, ask the user to run that update.`,
		};
	} catch (error) {
		if (error instanceof Refusal) return { message: error.message };
		const project = posix.dirname(path);
		return {
			message: `cagr could not check that ${manager} wrote this lockfile. ${(error as Error).message} The check copies the manifests to a temp folder and runs ${manager} offline with scripts off. Make it pass: install ${manager}, or run \`${manager} install\` in ${shellQuote(join(root, project))} so its cache has every package, then stop again. If it cannot pass, restore the file with the steps that follow and ask the user to make the dependency change.`,
		};
	}
}
