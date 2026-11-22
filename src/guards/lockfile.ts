import { existsSync } from "node:fs";
import {
	cp,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix } from "node:path";
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

const manifests = new Set([
	"package.json",
	"pnpm-workspace.yaml",
	".npmrc",
	"bunfig.toml",
	".yarnrc",
	".yarnrc.yml",
]);
const extraDirs = [".yarn/releases/", ".yarn/plugins/", ".yarn/patches/"];
const dependencyFields = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies",
	"overrides",
	"resolutions",
	"patchedDependencies",
];

export const isLockfile = (path: string) =>
	Object.hasOwn(writers, basename(path));

/** Null message: the package manager wrote this lockfile. */
export type LockfileVerdict = { message: string | null };

function managerFor(stacks: LockfileStack[], path: string) {
	return stacks.find(
		(stack) =>
			stack.package_manager !== null &&
			stack.paths.some((glob) => matchesGlob(glob, path)) &&
			!stack.exclude_paths?.some((glob) => matchesGlob(glob, path)),
	)?.package_manager;
}

type Command = { argv: string[]; env?: Record<string, string> };

/** The command, and its environment, that makes the manager rewrite only the lockfile without the network or scripts. The starting lockfile, when there is one, picks the Yarn major version, since the current one is under check. */
function command(manager: Writer, lockfile: Uint8Array): Command {
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
					"--ignore-pnpmfile",
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
			if (/^__metadata:/m.test(new TextDecoder().decode(lockfile)))
				return {
					argv: ["yarn", "install", "--mode=update-lockfile"],
					env: {
						YARN_ENABLE_NETWORK: "0",
						YARN_ENABLE_SCRIPTS: "0",
						YARN_ENABLE_IMMUTABLE_INSTALLS: "0",
						YARN_ENABLE_TELEMETRY: "0",
						COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
						COREPACK_ENABLE_NETWORK: "0",
					},
				};
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
				],
				env: {
					COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
					COREPACK_ENABLE_NETWORK: "0",
				},
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

/** Copies what the package manager reads for the lockfile at `path`: manifests, its config and local packages. */
async function copyInputs(
	root: string,
	path: string,
	target: string,
	deadline: number,
) {
	const project = posix.dirname(path);
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
		{ timeoutMs: Math.max(1, Math.floor(deadline - performance.now())) },
	);
	if (!listed.ok) throw new Error(`git ls-files failed: ${listed.output}`);
	const files = listed.stdout.split("\0").filter((file) => {
		const inProject = project === "." ? file : file.slice(project.length + 1);
		return (
			manifests.has(basename(file)) ||
			extraDirs.some((dir) => inProject.startsWith(dir)) ||
			inProject.startsWith("patches/")
		);
	});
	const refs = new Set<string>();
	for (const file of files) {
		const source = join(root, file);
		if (!existsSync(source)) continue;
		await mkdir(dirname(join(target, file)), { recursive: true });
		await cp(source, join(target, file));
		if (basename(file) === "package.json")
			for (const ref of localRefs(file, await readFile(source, "utf8")))
				refs.add(ref);
	}
	for (const ref of refs) {
		const source = join(root, ref);
		if (insideRoot(root, source) === null || !existsSync(source)) continue;
		await cp(source, join(target, ref), {
			recursive: true,
			filter: (from) => {
				if (performance.now() > deadline)
					throw new Error(`Copying the local package ${ref} ran out of time.`);
				return !/(^|\/)(node_modules|\.git)$/.test(from);
			},
		});
	}
}

async function regenerate(
	spec: Command,
	root: string,
	path: string,
	lockfile: Uint8Array | null,
	deadline: number,
) {
	const folder = await mkdtemp(join(tmpdir(), "cagr-lockfile-"));
	try {
		await copyInputs(root, path, folder, deadline);
		const file = join(folder, path);
		// A local ref to the project folder copies the lockfile under check, so replace or remove it.
		if (lockfile) await writeFile(file, lockfile);
		else await rm(file, { force: true });
		const timeoutMs = Math.floor(deadline - performance.now());
		if (timeoutMs <= 0) throw new Error("No time was left to run it.");
		const result = await run(spec.argv, dirname(file), {
			timeoutMs,
			env: spec.env,
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

const same = (a: Uint8Array | null, b: Uint8Array | null) =>
	a !== null && b !== null && Buffer.from(a).equals(Buffer.from(b));

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
	deadline: number;
}): Promise<LockfileVerdict | null> {
	const { root, path, stacks, baseline, deadline } = options;
	const writer = writers[basename(path)];
	if (!writer) return null;
	const manager = managerFor(stacks, path);
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
		// The second run normalises the current file, since `bun add` writes keys in an order `bun install` later sorts.
		const [rewritten, normalised] = await Promise.all([
			regenerate(spec, root, path, baseline, deadline),
			regenerate(spec, root, path, current, deadline),
		]);
		if (same(rewritten, current) || same(rewritten, normalised))
			return { message: null };
		return {
			message: `This is not what ${manager} writes from the current manifests and the lockfile at the start of the turn, so it looks edited by hand. Change dependencies with ${manager} add or remove instead. If an update command changed versions without changing package.json, ask the user to run that update.`,
		};
	} catch (error) {
		const project = posix.dirname(path);
		return {
			message: `cagr could not check that ${manager} wrote this lockfile. ${(error as Error).message} The check copies the manifests to a temp folder and runs ${manager} offline with scripts off. Make it pass: install ${manager}, or run \`${manager} install\` in ${shellQuote(join(root, project))} so its cache has every package, then stop again. If it cannot pass, restore the file with the steps that follow and ask the user to make the dependency change.`,
		};
	}
}
