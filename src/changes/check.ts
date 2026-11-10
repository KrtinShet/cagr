import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
	readlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { Config } from "../config/schema";
import { loadRuleSet } from "../rules/rules";
import { run } from "../run";
import { type Change, evaluate, formatChange } from "./rules";

export type Snapshot = {
	target: string;
	base: string;
	head: string;
	changes: Change[];
	pending: boolean;
};
export async function collect(
	config: Config,
	options: { base?: string; committed?: boolean; deadline?: number } = {},
): Promise<Snapshot> {
	const deadline = options.deadline ?? performance.now() + 15_000;
	const git = async (...args: string[]) => {
		if (performance.now() >= deadline)
			throw Error("collection deadline exceeded");
		const result = await run(["git", ...args], config.root, {
			timeoutMs: Math.max(1, Math.floor(deadline - performance.now())),
			env: { GIT_OPTIONAL_LOCKS: "0" },
		});
		if (!result.ok)
			throw Error(`git ${args[0]} failed: ${result.output.trim()}`);
		if (result.stdout.length > 8_000_000)
			throw Error("Git output exceeds 8 MB");
		return result.stdout;
	};
	const name = options.base || config.git.protected_branch || "main";
	let target: string;
	try {
		target = (
			await git("rev-parse", "--verify", `origin/${name}^{commit}`)
		).trim();
	} catch {
		target = (await git("rev-parse", "--verify", `${name}^{commit}`)).trim();
	}
	const head = (await git("rev-parse", "HEAD")).trim();
	if ((await git("rev-parse", "--is-shallow-repository")).trim() === "true")
		throw Error("history is shallow");
	const bases = (await git("merge-base", "--all", target, head))
		.trim()
		.split("\n")
		.filter(Boolean);
	if (bases.length !== 1)
		throw Error("the target and HEAD need one unique merge base");
	const base = bases[0] ?? "";
	const snapshot = async () => {
		if ((await git("ls-files", "--unmerged", "-z")).length)
			throw Error("resolve unmerged index entries first");
		const raw = (
			await git(
				"diff",
				"--raw",
				"--no-abbrev",
				"--no-renames",
				"--no-ext-diff",
				"--no-textconv",
				"-z",
				base,
				...(options.committed ? [head] : []),
				"--",
			)
		).split("\0");
		const changes: Change[] = [];
		const identities: string[] = [];
		for (let i = 0; i < raw.length - 1; i += 2) {
			const fields = (raw[i] ?? "").split(" ");
			const path = raw[i + 1] ?? "";
			const status = fields[4] as Change["status"];
			if (!["A", "M", "D", "T"].includes(status))
				throw Error(`unsupported Git status ${status}`);
			changes.push({ path, status, regular: fields[1]?.startsWith("100") });
			identities.push(raw[i] ?? "", path);
		}
		if (!options.committed) {
			const known = new Set(changes.map((change) => change.path));
			for (const path of (
				await git("ls-files", "--others", "--exclude-standard", "-z")
			)
				.split("\0")
				.filter(Boolean))
				if (!known.has(path)) changes.push({ path, status: "A" });
			for (const change of changes) {
				if (performance.now() >= deadline)
					throw Error("collection deadline exceeded");
				if (change.status === "D") continue;
				const path = join(config.root, change.path);
				const stat = lstatSync(path);
				change.regular = stat.isFile();
				if (stat.isFile()) {
					if (stat.size > 32_000_000)
						throw Error("changed file exceeds the 32 MB snapshot limit");
					const descriptor = openSync(
						path,
						constants.O_RDONLY | constants.O_NOFOLLOW,
					);
					try {
						const opened = fstatSync(descriptor);
						if (!opened.isFile() || opened.size > 32_000_000)
							throw Error("file changed during snapshot");
						identities.push(
							String(opened.mode),
							new Bun.CryptoHasher("sha256")
								.update(readFileSync(descriptor))
								.digest("hex"),
						);
					} finally {
						closeSync(descriptor);
					}
				} else
					identities.push(
						String(stat.mode),
						stat.isSymbolicLink() ? readlinkSync(path) : String(stat.mtimeMs),
					);
			}
		}
		if (changes.length > 20_000) throw Error("change exceeds 20000 paths");
		return { changes, fingerprint: JSON.stringify([identities, changes]) };
	};
	for (let attempt = 0; attempt < 2; attempt++) {
		const first = await snapshot();
		const second = options.committed ? first : await snapshot();
		if (
			first.fingerprint !== second.fingerprint ||
			(await git("rev-parse", "HEAD")).trim() !== head
		)
			continue;
		const pending =
			!options.committed &&
			(await git("diff", "--raw", "-z", "--no-renames", "--cached", "--"))
				.length > 0;
		return { target, base, head, changes: second.changes, pending };
	}
	throw Error("snapshot changed during collection; retry after writes stop");
}
export async function checkChanges(
	config: Config,
	options: Parameters<typeof collect>[1] = {},
) {
	const started = performance.now();
	try {
		loadRuleSet(config);
		const snapshot = await collect(config, options);
		const collected = performance.now();
		const findings = evaluate(config.changes.rules, snapshot.changes);
		const evaluated = performance.now();
		if (options.deadline && evaluated >= options.deadline)
			throw Error("evaluation deadline exceeded");
		const output = [
			`Range: merge base ${snapshot.base} to ${options?.committed ? snapshot.head : "working tree"} (target ${snapshot.target}).`,
			...findings.slice(0, 2).map(formatChange),
			...(findings.length > 2
				? [
						`${findings.length - 2} more findings. Fix these and rerun cagr rules check.`,
					]
				: []),
			...(snapshot.pending
				? [
						"Pending staged content exists. Stage the intended result and rerun the committed check before opening a PR; staged content cannot satisfy a working-tree companion.",
					]
				: []),
		].join("\n");
		return {
			ok: findings.length === 0,
			unchecked: false,
			output,
			findings,
			snapshot,
			collectionMs: collected - started,
			evaluationMs: evaluated - collected,
		};
	} catch (error) {
		return {
			ok: false,
			unchecked: true,
			output: `Unchecked: change rules: ${(error as Error).message}. Fetch the target history, resolve conflicts or stop concurrent writes, then run cagr rules check --base <target> and rerun CI.`,
			findings: [],
			snapshot: undefined,
			collectionMs: performance.now() - started,
			evaluationMs: 0,
		};
	}
}
