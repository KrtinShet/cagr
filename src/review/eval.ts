import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Config, Effort } from "../config/schema";
import { gitContext } from "../git";
import { run } from "../run";
import type { ReviewAgent } from "./agent";
import { ReviewInputError, review } from "./review";
import { emptyRecord, type ReviewFinding } from "./types";

/** A past change with a known answer: a bug the reviewer should find, or a clean change it should pass. */
export type EvalCase = {
	name: string;
	base: string;
	head: string;
	expect: { file: string; line: number | null }[];
	clean: boolean;
};

export type EvalResult = {
	name: string;
	found: number;
	expected: number;
	falsePositives: number;
	error: string | null;
};

export const evalDir = (config: Config) =>
	join(config.root, ".cagr", "review-evals");

export function loadEvalCases(dir: string): EvalCase[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".toml"))
		.sort()
		.map((name) => {
			const file = join(dir, name);
			const raw = Bun.TOML.parse(readFileSync(file, "utf8")) as Record<
				string,
				unknown
			>;
			if (typeof raw.base !== "string" || typeof raw.head !== "string")
				throw new ReviewInputError(
					`${file}: set base and head to the commits around the change.`,
				);
			const expect = (Array.isArray(raw.expect) ? raw.expect : []).map(
				(entry) => {
					const item = entry as Record<string, unknown>;
					if (typeof item.file !== "string")
						throw new ReviewInputError(
							`${file}: each [[expect]] needs the file where the bug is.`,
						);
					return {
						file: item.file,
						line: typeof item.line === "number" ? item.line : null,
					};
				},
			);
			const clean = raw.clean === true;
			if (clean === expect.length > 0)
				throw new ReviewInputError(
					`${file}: give either [[expect]] entries for a bug, or clean = true for a change with none.`,
				);
			return {
				name:
					typeof raw.name === "string" ? raw.name : name.replace(/\.toml$/, ""),
				base: raw.base,
				head: raw.head,
				expect,
				clean,
			};
		});
}

/** An expected bug counts as found when an Important finding lands in its file, near its line. */
export function scoreCase(
	testCase: EvalCase,
	findings: ReviewFinding[],
): Omit<EvalResult, "name" | "error"> {
	const important = findings.filter(
		(finding) => finding.severity === "important",
	);
	const hits = (expected: EvalCase["expect"][number], finding: ReviewFinding) =>
		finding.file === expected.file &&
		(expected.line === null ||
			finding.line === 0 ||
			Math.abs(finding.line - expected.line) <= 10);
	const found = testCase.expect.filter((expected) =>
		important.some((finding) => hits(expected, finding)),
	).length;
	const falsePositives = testCase.clean
		? important.length
		: important.filter(
				(finding) =>
					!testCase.expect.some((expected) => hits(expected, finding)),
			).length;
	return { found, expected: testCase.expect.length, falsePositives };
}

export async function runEvals(
	config: Config,
	cwd: string,
	options: {
		agent?: ReviewAgent;
		effort?: Effort;
		only?: string;
		progress?: (line: string) => void;
	} = {},
): Promise<EvalResult[]> {
	const git = await gitContext(cwd);
	if (!git.toplevel || !git.commonDir)
		throw new ReviewInputError("Run `cagr review eval` inside the repo.");
	const cases = loadEvalCases(evalDir(config)).filter(
		(entry) => !options.only || entry.name === options.only,
	);
	if (cases.length === 0)
		throw new ReviewInputError(
			`No eval cases in ${evalDir(config)}. Add one per past bug: base and head commits, and [[expect]] file and line.`,
		);
	const results: EvalResult[] = [];
	for (const testCase of cases) {
		const tree = join(
			git.commonDir,
			"cagr",
			"eval-trees",
			testCase.name.replace(/[^\w.-]/g, "_"),
		);
		rmSync(tree, { recursive: true, force: true });
		await run(["git", "worktree", "prune"], git.toplevel);
		options.progress?.(`Eval ${testCase.name}`);
		const added = await run(
			["git", "worktree", "add", "--detach", tree, testCase.head],
			git.toplevel,
		);
		if (!added.ok) {
			results.push({
				name: testCase.name,
				found: 0,
				expected: testCase.expect.length,
				falsePositives: 0,
				error: added.output.trim(),
			});
			continue;
		}
		try {
			const outcome = await review(config, {
				cwd: tree,
				base: testCase.base,
				full: true,
				effort: options.effort,
				agent: options.agent,
				record: emptyRecord(testCase.name, testCase.base),
				progress: options.progress,
			});
			results.push({
				name: testCase.name,
				...scoreCase(testCase, outcome.found),
				error: outcome.round?.error ?? null,
			});
		} catch (error) {
			results.push({
				name: testCase.name,
				found: 0,
				expected: testCase.expect.length,
				falsePositives: 0,
				error: (error as Error).message,
			});
		} finally {
			await run(["git", "worktree", "remove", "--force", tree], git.toplevel);
		}
	}
	return results;
}

const lastRunFile = (commonDir: string) =>
	join(commonDir, "cagr", "evals", "last.json");

export function evalReport(
	results: EvalResult[],
	previous: EvalResult[] | null,
) {
	const total = (
		list: EvalResult[],
		key: "found" | "expected" | "falsePositives",
	) => list.reduce((sum, entry) => sum + entry[key], 0);
	const recall = (list: EvalResult[]) =>
		total(list, "expected") === 0
			? null
			: total(list, "found") / total(list, "expected");
	const pct = (value: number | null) =>
		value === null ? "n/a" : `${Math.round(value * 100)}%`;
	const lines = results.map(
		(entry) =>
			`${entry.error ? "ERROR" : entry.found === entry.expected && entry.falsePositives === 0 ? "PASS " : "MISS "} ${entry.name}: found ${entry.found}/${entry.expected}, ${entry.falsePositives} false positive${entry.falsePositives === 1 ? "" : "s"}${entry.error ? ` (${entry.error})` : ""}`,
	);
	lines.push(
		"",
		`Recall ${pct(recall(results))}, false positives ${total(results, "falsePositives")}.`,
	);
	if (previous)
		lines.push(
			`Last run: recall ${pct(recall(previous))}, false positives ${total(previous, "falsePositives")}. A drop after a REVIEW.md or model change means the change made the reviewer worse.`,
		);
	return lines.join("\n");
}

export function readLastRun(commonDir: string): EvalResult[] | null {
	try {
		return JSON.parse(
			readFileSync(lastRunFile(commonDir), "utf8"),
		) as EvalResult[];
	} catch {
		return null;
	}
}

export function writeLastRun(commonDir: string, results: EvalResult[]) {
	const file = lastRunFile(commonDir);
	mkdirSync(join(commonDir, "cagr", "evals"), { recursive: true });
	writeFileSync(file, `${JSON.stringify(results, null, "\t")}\n`);
}
