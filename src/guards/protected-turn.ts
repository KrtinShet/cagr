import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Config, ProtectedFile } from "../config/schema";
import type { HookInput } from "../hook/types";
import { run, shellQuote } from "../run";
import {
	programName,
	programWords,
	simpleCommands,
	withoutHeredocBodies,
} from "../shell";
import type { CheckResult } from "../stop-decision";
import { protectedStateDir } from "../turn-state";
import { gitOptionsWithValue } from "./command";
import { protectedEntries, protectedEntry } from "./edit";
import { checkLockfile, isLockfile, type LockfileStack } from "./lockfile";

type Blob = { mode: string; oid: string };
type IndexEntry = Blob & { stage: string };
type StatusPath = { workStatus: string; index: IndexEntry[] };
type FileState = {
	index: IndexEntry[];
	/** Missing means the working copy matches the index. Null means deleted. */
	work?: string | null;
};
type Snapshot = {
	root: string;
	head?: string | null;
	branch: string | null;
	entries: ProtectedFile[];
	files: Record<string, FileState> | null;
	/** The stacks at the start of the turn, so turn end knows each lockfile's package manager. */
	stacks?: LockfileStack[];
};

const hash = (bytes: string | Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");

export function checkoutOf(dir: string): string | null {
	for (;;) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function checkouts(input: HookInput) {
	const dirs = [input.cwd, ...input.files.map(dirname)];
	// A command may start here and do its work in a named sibling checkout.
	let cwd = input.cwd;
	for (const raw of simpleCommands(withoutHeredocBodies(input.command ?? ""))) {
		const words = programWords(raw);
		const name = programName(words);
		const destination = words[1] === "--" ? words[2] : words[1];
		if (name === "cd" && destination && !/^[~-]|[$*?]/.test(destination)) {
			cwd = resolve(cwd, destination);
			dirs.push(cwd);
		}
		if (name !== "git") continue;
		let gitDir = cwd;
		for (let i = 1; words[i]?.startsWith("-"); i++) {
			const option = words[i] ?? "";
			if (!gitOptionsWithValue.has(option)) continue;
			const target = words[++i];
			if (option === "-C" && target) gitDir = resolve(gitDir, target);
		}
		dirs.push(gitDir);
	}
	return [
		...new Set(
			dirs
				.map(checkoutOf)
				.filter((root) => root !== null)
				.map((root) => realpathSync(root)),
		),
	];
}

async function git(
	root: string,
	args: string[],
	deadline: number,
	absentCode?: number,
) {
	const time = Math.floor(deadline - performance.now());
	if (time <= 0) throw new Error("Protected-file snapshot ran out of time.");
	const result = await run(["git", ...args], root, {
		env: { GIT_OPTIONAL_LOCKS: "0" },
		timeoutMs: time,
	});
	if (result.ok) return result.stdout;
	if (result.exitCode === absentCode) return null;
	throw new Error(
		`Could not check protected files in ${root}. ${result.output.trim()}`,
	);
}

function protectedPathspecs(entries: ProtectedFile[]): string[] {
	const pathspecs = new Set<string>();
	for (const { glob } of entries) {
		const alternatives = /^\{([\w.,-]+)\}$/.exec(glob)?.[1]?.split(",") ?? [
			glob,
		];
		for (const pattern of alternatives) {
			const path = pattern.replace(/^\//, "");
			if (
				!path ||
				/[^\w./*-]/.test(path) ||
				path.split("/").some((part) => part !== "**" && part.includes("**"))
			) {
				// Git pathspecs cannot express every Bun glob. Filter those results in cagr.
				return [];
			}
			pathspecs.add(`:(glob)${pattern.includes("/") ? path : `**/${path}`}`);
		}
	}
	return [...pathspecs];
}

async function status(
	root: string,
	entries: ProtectedFile[],
	deadline: number,
) {
	const result = await git(
		root,
		[
			"status",
			"--porcelain=v2",
			"-z",
			"--branch",
			"--no-ahead-behind",
			"--no-renames",
			"--untracked-files=all",
			"--",
			...protectedPathspecs(entries),
		],
		deadline,
	);
	let head: string | null = null;
	const paths = new Map<string, StatusPath>();
	for (const record of result?.split("\0") ?? []) {
		if (record.startsWith("# branch.oid ")) {
			const oid = record.slice(13);
			head = oid === "(initial)" ? null : oid;
			continue;
		}
		const tracked = /^1 (..) \S+ \S+ (\S+) \S+ \S+ (\S+) /.exec(record);
		const conflict = /^u \S+ \S+ (\S+) (\S+) (\S+) \S+ (\S+) (\S+) (\S+) /.exec(
			record,
		);
		const prefix =
			tracked?.[0] ?? conflict?.[0] ?? (record.startsWith("? ") ? "? " : "");
		if (!prefix) continue;
		const path = record.slice(prefix.length);
		if (!protectedEntry(entries, path)) continue;
		const index: IndexEntry[] = paths.get(path)?.index ?? [];
		if (tracked?.[2] && tracked[2] !== "000000" && tracked[3])
			index.push({ mode: tracked[2], oid: tracked[3], stage: "0" });
		for (const stage of [1, 2, 3]) {
			const mode = conflict?.[stage];
			const oid = conflict?.[stage + 3];
			if (mode && mode !== "000000" && oid)
				index.push({ mode, oid, stage: String(stage) });
		}
		paths.set(path, { workStatus: tracked?.[1]?.[1] ?? "?", index });
	}
	return { head, paths };
}

async function tree(
	root: string,
	ref: string | null,
	paths: string[],
	deadline: number,
) {
	const blobs = new Map<string, Blob>();
	if (!ref || paths.length === 0) return blobs;
	const result = await git(
		root,
		["--literal-pathspecs", "ls-tree", "-r", "-z", ref, "--", ...paths],
		deadline,
	);
	for (const record of result?.split("\0") ?? []) {
		if (!record) continue;
		const tab = record.indexOf("\t");
		const [mode = "", , oid = ""] = record.slice(0, tab).split(" ");
		blobs.set(record.slice(tab + 1), { mode, oid });
	}
	return blobs;
}

async function workingCopy(
	path: string,
	backup?: string,
): Promise<string | null> {
	const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
	if (!info || info.isDirectory()) return null;
	if (info.isSymbolicLink()) {
		const target = await readlink(path);
		if (backup) await symlink(target, backup);
		return `120000 ${hash(target)}`;
	}
	if (!info.isFile()) throw new Error(`Cannot read protected file ${path}.`);
	const content = await readFile(path);
	if (backup) await writeFile(backup, content, { mode: info.mode & 0o777 });
	return `${info.mode & 0o111 ? "100755" : "100644"} ${hash(content)}`;
}

async function captureFiles(
	root: string,
	folder: string,
	paths: Map<string, StatusPath>,
) {
	const files = await Promise.allSettled(
		[...paths].map(async ([path, { workStatus, index }]) => {
			const state: FileState = { index };
			if (workStatus === "D") state.work = null;
			else if (workStatus !== ".")
				state.work = await workingCopy(
					join(root, path),
					join(folder, hash(path)),
				);
			return [path, state] as const;
		}),
	);
	return files.every((entry) => entry.status === "fulfilled")
		? Object.fromEntries(files.map((entry) => entry.value))
		: null;
}

/** Milliseconds the starting snapshot may take, inside the command budget. Tests on a loaded machine raise it. */
export const snapshotBudget = { commandMs: 40, toolMs: 250 };

export async function rememberProtected(
	file: string,
	input: HookInput,
	config: Config,
) {
	const entries = protectedEntries(config.files);
	if (!entries.length) return;
	const deadline =
		performance.now() +
		(input.event === "command.before"
			? snapshotBudget.commandMs
			: snapshotBudget.toolMs);
	const directory = protectedStateDir(file);
	const captures = await Promise.allSettled(
		checkouts(input).map(async (root) => {
			const target = join(directory, hash(root));
			if (existsSync(target)) return;
			// Start both Git reads before a slow status can spend the command budget.
			const startHead = git(
				root,
				["rev-parse", "--verify", "--quiet", "HEAD"],
				deadline,
				1,
			).then(
				(head) => head?.trim() ?? null,
				() => undefined,
			);
			const startStatus = status(root, entries, deadline).catch(() => null);
			await mkdir(directory, { recursive: true, mode: 0o700 });
			const temporary = await mkdtemp(join(directory, ".capture-"));
			try {
				const previous = await startStatus;
				const files = previous
					? await captureFiles(root, temporary, previous.paths)
					: null;
				const snapshot: Snapshot = {
					root,
					head: previous ? previous.head : await startHead,
					branch: config.git.protected_branch,
					entries,
					files,
					stacks: config.stack.map(
						({ paths, exclude_paths, package_manager }) => ({
							paths,
							exclude_paths,
							package_manager,
						}),
					),
				};
				await writeFile(
					join(temporary, "snapshot.json"),
					JSON.stringify(snapshot),
				);
				// Parallel tools must not replace the first baseline once a tool can write.
				try {
					await rename(temporary, target);
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code;
					if (code === "EEXIST" || code === "ENOTEMPTY") return;
					throw error;
				}
				if (snapshot.files === null)
					return snapshot.head === undefined ? "no-head" : "head";
			} finally {
				await rm(temporary, { recursive: true, force: true });
			}
		}),
	);
	const incomplete = captures.filter(
		(capture) => capture.status === "rejected" || capture.value,
	);
	if (incomplete.length)
		return snapshotNotice(
			file,
			incomplete.some(
				(capture) =>
					capture.status === "rejected" || capture.value === "no-head",
			),
		);
}

export async function snapshotNotice(file: string, unavailable: boolean) {
	const directory = protectedStateDir(file);
	try {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		await writeFile(join(directory, ".notice"), "", { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
	}
	return unavailable
		? "cagr could not record a starting commit for some protected files. Review those changes manually before continuing."
		: "cagr could not snapshot protected files. The turn-end check will use the starting commit and may flag earlier changes.";
}

function indexMatches(index: IndexEntry[], blob: Blob | undefined) {
	if (!blob) return index.length === 0;
	return (
		index.length === 1 &&
		index[0]?.stage === "0" &&
		index[0].mode === blob.mode &&
		index[0].oid === blob.oid
	);
}

function sameBlob(a: Blob | undefined, b: Blob | undefined) {
	return a?.oid === b?.oid && a?.mode === b?.mode;
}

function restoration(
	snapshot: Snapshot,
	folder: string,
	path: string,
	before: FileState,
	oldHead: Blob | undefined,
	committed: boolean,
) {
	const fullPath = shellQuote(join(snapshot.root, path));
	const argv = `git --literal-pathspecs -C ${shellQuote(snapshot.root)}`;
	const file = `-- ${shellQuote(path)}`;
	const clearIndex = `${argv} update-index --force-remove ${file}`;
	const restore = (target: string) =>
		`${argv} restore --source=${snapshot.head} ${target} ${file}`;
	const steps: string[] = [];
	const removeFile = `Delete the file with \`rm -f ${fullPath}\` if it exists.`;
	if (oldHead) {
		steps.push(`Run \`${restore("--staged --worktree")}\`.`);
	} else {
		steps.push(`Clear any staged copy with \`${clearIndex}\`.`, removeFile);
	}
	if (committed)
		steps.push(
			"Commit the reversal for this path before restoring any pre-existing changes below.",
		);
	if (!indexMatches(before.index, oldHead)) {
		const [entry] = before.index;
		if (!entry) {
			steps.push(`Restore the prior staged deletion with \`${clearIndex}\`.`);
			if (before.work === undefined) steps.push(removeFile);
		} else if (before.index.length === 1 && entry.stage === "0") {
			const cacheInfo = shellQuote(`${entry.mode},${entry.oid},${path}`);
			steps.push(
				`Restore the prior staged copy with \`${argv} update-index --add --cacheinfo ${cacheInfo}\`.`,
			);
		} else {
			const records = before.index.map(({ mode, oid, stage }) =>
				shellQuote(`${mode} ${oid} ${stage}\t${path}`),
			);
			steps.push(
				`Restore the prior index stages with \`${clearIndex} && printf '%s\\0' ${records.join(" ")} | ${argv} update-index -z --index-info\`.`,
			);
		}
	}
	if (before.work) {
		const backup = shellQuote(join(folder, hash(path)));
		steps.push(
			removeFile,
			`Restore the prior working copy with \`cp -pP ${backup} ${fullPath}\`.`,
		);
	} else if (before.work === null) steps.push(removeFile);
	else if (!indexMatches(before.index, oldHead) && before.index.length) {
		steps.push(
			`Restore the working copy from the index with \`${argv} restore --worktree ${file}\`.`,
		);
	}
	return steps.join(" ");
}

async function protectedBranch(snapshot: Snapshot, deadline: number) {
	if (!snapshot.branch) return null;
	for (const prefix of ["refs/remotes/origin", "refs/heads"]) {
		const ref = await git(
			snapshot.root,
			[
				"rev-parse",
				"--verify",
				"--quiet",
				`${prefix}/${snapshot.branch}^{commit}`,
			],
			deadline,
			1,
		);
		if (!ref) continue;
		if (prefix === "refs/heads") {
			const branch = await git(
				snapshot.root,
				["symbolic-ref", "--quiet", "HEAD"],
				deadline,
				1,
			);
			if (branch?.trim() === `refs/heads/${snapshot.branch}`)
				return snapshot.head ?? null;
		}
		return ref.trim();
	}
	return null;
}

/** The lockfile content at the start of the turn: the saved working copy, the staged copy or the commit. */
async function startingContent(
	snapshot: Snapshot,
	folder: string,
	path: string,
	before: FileState | undefined,
	old: Blob | undefined,
	deadline: number,
): Promise<Uint8Array | null | undefined> {
	if (typeof before?.work === "string")
		return new Uint8Array(await readFile(join(folder, hash(path))));
	if (before?.work === null) return null;
	const [entry, ...rest] = before ? before.index : old ? [old] : [];
	if (!entry) return null;
	if (rest.length || ("stage" in entry && entry.stage !== "0"))
		return undefined;
	const text = await git(
		snapshot.root,
		["cat-file", "blob", entry.oid],
		deadline,
	);
	return text === null ? undefined : new TextEncoder().encode(text);
}

async function violations(
	folder: string,
	deadline: number,
	lockfileDeadline: number,
) {
	const snapshot: Snapshot = JSON.parse(
		await readFile(join(folder, "snapshot.json"), "utf8"),
	);
	const { root, entries } = snapshot;
	if (!existsSync(join(root, ".git"))) return [];
	if (snapshot.head === undefined)
		return [
			`- ${root}\n  cagr could not record the starting commit. Review protected-file changes in the worktree, index and commits before continuing.`,
		];
	const { head, paths: changed } = await status(root, entries, deadline);
	let committedPaths: string[] = [];
	if (snapshot.head !== head) {
		const diff =
			snapshot.head && head
				? await git(
						root,
						["diff", "--name-only", "-z", "--no-renames", snapshot.head, head],
						deadline,
					)
				: await git(
						root,
						[
							"ls-tree",
							"-r",
							"--name-only",
							"-z",
							head ?? snapshot.head ?? "HEAD",
						],
						deadline,
					);
		committedPaths = diff?.split("\0") ?? [];
	}
	const paths = [
		...new Set([
			...Object.keys(snapshot.files ?? {}),
			...changed.keys(),
			...committedPaths,
		]),
	].filter((path) => path && protectedEntry(entries, path));
	if (!paths.length) return [];
	const [oldTree, newTree, upstream] = await Promise.all([
		tree(root, snapshot.head, paths, deadline),
		tree(root, head, paths, deadline),
		protectedBranch(snapshot, deadline),
	]);
	const branchTree = await tree(root, upstream, paths, deadline);
	const problems = await Promise.all(
		paths.map(async (path) => {
			const old = oldTree.get(path);
			const current = newTree.get(path);
			const branch = branchTree.get(path);
			const before =
				snapshot.files && Object.hasOwn(snapshot.files, path)
					? snapshot.files[path]
					: undefined;
			const baseline = before ?? { index: old ? [{ ...old, stage: "0" }] : [] };
			const change = changed.get(path);
			const index =
				change?.index ?? (current ? [{ ...current, stage: "0" }] : []);
			let work: FileState["work"];
			if (change?.workStatus === "D") work = null;
			else if (change && change.workStatus !== ".")
				work = await workingCopy(join(root, path));
			const committed = !sameBlob(old, current);
			if (
				!committed &&
				work === baseline.work &&
				JSON.stringify(index) === JSON.stringify(baseline.index)
			)
				return null;
			if (
				upstream &&
				work === undefined &&
				indexMatches(index, branch) &&
				(!committed || sameBlob(branch, current))
			)
				return null;
			// A lockfile is checked as one copy: the working copy, with the index and commit unchanged or matching it.
			const onlyWorkingCopy =
				!committed && JSON.stringify(index) === JSON.stringify(baseline.index);
			const [entry, ...others] = index;
			const oneCopy =
				work === undefined &&
				entry?.stage === "0" &&
				others.length === 0 &&
				(!committed || sameBlob(current, entry));
			const checked = isLockfile(path);
			const starting =
				checked && (onlyWorkingCopy || oneCopy)
					? await startingContent(
							snapshot,
							folder,
							path,
							before,
							old,
							deadline,
						).catch(() => undefined)
					: undefined;
			const lockfile =
				starting === undefined
					? null
					: await checkLockfile({
							root,
							path,
							stacks: snapshot.stacks ?? [],
							baseline: starting,
							head: snapshot.head ?? null,
							deadline: lockfileDeadline,
						});
			if (lockfile && lockfile.message === null) return null;
			let note = lockfile ? `${lockfile.message} ` : "";
			if (checked && !onlyWorkingCopy && !oneCopy)
				note =
					"cagr checks a lockfile when only its working copy changed, or when the working copy, the index and the last commit hold the same version. Stage and commit the lockfile the package manager wrote, or restore it. ";
			if (!snapshot.files)
				return `- ${join(root, path)}\n  ${note}Review changes against ${snapshot.head ?? "the empty starting tree"}. Restore only changes made during this turn.`;
			return `- ${join(root, path)}\n  ${note}${restoration(snapshot, folder, path, baseline, old, committed)}`;
		}),
	);
	return problems.filter((problem) => problem !== null);
}

export async function checkProtected(
	file: string,
	deadline: number,
	lockfileDeadline = deadline,
): Promise<CheckResult | null> {
	const directory = protectedStateDir(file);
	if (!existsSync(directory)) return null;
	const folders = (await readdir(directory)).filter(
		(name) => !name.startsWith("."),
	);
	const problems = (
		await Promise.all(
			folders.map((name) =>
				violations(join(directory, name), deadline, lockfileDeadline),
			),
		)
	).flat();
	return problems.length
		? {
				name: "Protected files",
				ok: false,
				output: `Review the protected files below and restore any changes made during this turn.\n${problems.join("\n")}`,
			}
		: null;
}
