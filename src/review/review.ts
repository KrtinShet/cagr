import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config, Effort } from "../config/schema";
import { gitContext } from "../git";
import { matchesGlob } from "../paths";
import { classify } from "../risk";
import { run } from "../run";
import {
	type AgentRequest,
	pickAgent,
	type ReviewAgent,
	ReviewerError,
} from "./agent";
import {
	type FinderOutput,
	type Focus,
	finderPrompt,
	finderSchema,
	type ReviewContext,
	type VerifierOutput,
	verifierPrompt,
	verifierSchema,
} from "./prompt";
import { loadRecord, recordPath, writeRecord } from "./store";
import {
	blocking,
	type Candidate,
	categories,
	type ReviewFinding,
	type ReviewRecord,
	type Round,
	type Severity,
	severities,
} from "./types";

/** A problem with the repo state, not with guardwright: the message says what to do. */
export class ReviewInputError extends Error {}

export type ReviewOptions = {
	cwd: string;
	base?: string;
	full?: boolean;
	effort?: Effort;
	/** Review existing code in these globs instead of a branch's commits. */
	scan?: string[];
	agent?: ReviewAgent;
	/** Use this record instead of the one in .git, and do not write it (CI keeps its own). */
	record?: ReviewRecord;
	progress?: (line: string) => void;
	now?: () => Date;
};

export type ReviewOutcome = {
	record: ReviewRecord;
	round: Round | null;
	found: ReviewFinding[];
	fixed: ReviewFinding[];
	passed: boolean;
	file: string | null;
	/** Set when there was nothing to review, with why. */
	skipped: string | null;
};

const maxDiff = 150_000;
const maxNits = 3;

async function gitOut(args: string[], cwd: string) {
	const result = await run(["git", ...args], cwd);
	if (!result.ok)
		throw new ReviewInputError(
			`git ${args.join(" ")} failed: ${result.output.trim()}`,
		);
	return result.output.trimEnd();
}

export async function resolveBase(name: string, cwd: string) {
	for (const ref of [`origin/${name}`, name]) {
		const result = await run(
			["git", "rev-parse", "--verify", "-q", `${ref}^{commit}`],
			cwd,
		);
		if (result.ok) return ref;
	}
	throw new ReviewInputError(
		`Cannot find the base branch "${name}". Fetch it, or pass --base <branch>.`,
	);
}

const isAncestor = async (older: string, newer: string, cwd: string) =>
	(await run(["git", "merge-base", "--is-ancestor", older, newer], cwd)).ok;

export async function review(
	config: Config,
	options: ReviewOptions,
): Promise<ReviewOutcome> {
	const progress = options.progress ?? (() => {});
	const now = options.now ?? (() => new Date());
	const git = await gitContext(options.cwd);
	if (!git.toplevel || !git.commonDir || !git.head)
		throw new ReviewInputError(
			"Run `guardwright review` inside a git repo with at least one commit.",
		);
	const cwd = git.toplevel;
	const head = git.head;
	const branch = git.branch ?? "detached";
	const baseName = options.base ?? config.git.protected_branch ?? "main";
	const scanning = options.scan !== undefined;

	if (!scanning) {
		const dirty = await gitOut(
			["status", "--porcelain", "--untracked-files=no"],
			cwd,
		);
		if (dirty !== "")
			throw new ReviewInputError(
				"Commit your changes first. The review covers commits, and the gate checks the commit you open the pull request from.",
			);
	}

	const file =
		options.record || scanning ? null : recordPath(git.commonDir, branch);
	const record =
		options.record ??
		(file
			? loadRecord(file, branch, baseName)
			: loadRecord("", branch, baseName));
	const lastOk = record.rounds.findLast((round) => !round.error);

	let from = head;
	let scope: Round["scope"] = "scan";
	let branchFiles: string[] = [];
	if (!scanning) {
		const baseRef = await resolveBase(baseName, cwd);
		const mergeBase = await gitOut(["merge-base", baseRef, head], cwd);
		if (mergeBase === head)
			return skippedOutcome(
				record,
				file,
				`No commits on ${branch} beyond ${baseName}, so there is nothing to review.`,
			);
		if (lastOk?.head === head && !options.full)
			return skippedOutcome(
				record,
				file,
				`${head.slice(0, 7)} was already reviewed in round ${lastOk.n}.`,
			);
		const incremental =
			!options.full &&
			lastOk !== undefined &&
			(await isAncestor(lastOk.head, head, cwd));
		from = incremental && lastOk ? lastOk.head : mergeBase;
		scope = incremental ? "diff" : "full";
		branchFiles = (await gitOut(["diff", "--name-only", mergeBase, head], cwd))
			.split("\n")
			.filter(Boolean);
	} else {
		branchFiles = (await gitOut(["ls-files"], cwd))
			.split("\n")
			.filter((path) => options.scan?.some((glob) => matchesGlob(glob, path)));
		if (branchFiles.length === 0)
			throw new ReviewInputError(
				`No tracked files match ${options.scan?.join(", ")}.`,
			);
	}

	const reviewed = branchFiles.filter(
		(path) => !config.review.skip.some((glob) => matchesGlob(glob, path)),
	);
	const risk = classify(reviewed, config);
	const effort =
		options.effort ?? (risk.tier === "high" ? "deep" : config.review.effort);
	const roundNumber = record.rounds.filter((round) => !round.error).length + 1;
	const exclude = config.review.skip.map((glob) => `:(exclude,glob)${glob}`);
	let diff = "";
	let log = "";
	if (!scanning) {
		diff = await gitOut(
			["diff", "--no-color", from, head, "--", ".", ...exclude],
			cwd,
		);
		if (diff.length > maxDiff)
			diff = `${diff.slice(0, maxDiff)}\n... (diff cut at ${maxDiff} characters; run \`git diff ${from.slice(0, 12)} ${head.slice(0, 12)}\` for the rest)\n\n${await gitOut(["diff", "--stat", from, head], cwd)}`;
		log = (
			await gitOut(
				["log", "--no-merges", "--format=- %s%n%b", `${from}..${head}`],
				cwd,
			)
		).slice(0, 6000);
	}
	const guidePath = join(config.root, config.review.guide);
	const context: ReviewContext = {
		branch,
		from,
		head,
		scope,
		tier: risk.tier,
		tierReasons: risk.reasons,
		effort,
		round: roundNumber,
		maxRounds: config.review.max_rounds,
		log,
		diff,
		guide: existsSync(guidePath) ? readFileSync(guidePath, "utf8") : null,
		skip: config.review.skip,
		scan: options.scan ?? [],
		previous: record.findings,
	};

	const round: Round = {
		n: roundNumber,
		head,
		from,
		scope,
		effort,
		tier: risk.tier,
		reviewer: "",
		at: now().toISOString(),
		summary: "",
		error: null,
	};
	let agent: ReviewAgent;
	try {
		agent = options.agent ?? pickAgent(config.review.reviewer);
	} catch (error) {
		return failed(record, round, file, error as Error);
	}
	round.reviewer = agent.name;
	const ask = (prompt: string, schema: object) =>
		agent.ask({
			prompt,
			schema,
			cwd,
			timeoutMs: config.review.timeout_seconds * 1000,
			model: config.review.model,
		} satisfies AgentRequest);

	try {
		const focuses = findersFor(effort, config.review.security);
		progress(
			`Reviewing ${scope === "diff" ? "the new commits" : scope === "scan" ? `${reviewed.length} files` : branch} with ${agent.name}: ${effort} effort, ${risk.tier} risk, ${focuses.length} finder${focuses.length === 1 ? "" : "s"}.`,
		);
		const outputs = await Promise.all(
			focuses.map(async (focus) =>
				normalizeFinder(await ask(finderPrompt(context, focus), finderSchema)),
			),
		);
		const candidates = mergeCandidates(
			outputs.flatMap((output) => output.findings),
			record.findings,
		);
		const open = record.findings.filter((finding) => finding.status === "open");
		const verifiers = effort === "deep" ? 3 : effort === "standard" ? 1 : 0;
		let kept = candidates;
		let fixedIds = new Set(outputs[0]?.fixed ?? []);
		if (verifiers > 0 && (candidates.length > 0 || open.length > 0)) {
			progress(
				`Checking ${candidates.length} candidate finding${candidates.length === 1 ? "" : "s"} with ${verifiers} verifier${verifiers === 1 ? "" : "s"}.`,
			);
			const keyed = candidates.map((candidate, index) => ({
				...candidate,
				key: `C${index + 1}`,
			}));
			const votes = await Promise.all(
				Array.from({ length: verifiers }, async () =>
					normalizeVerifier(
						await ask(verifierPrompt(context, keyed), verifierSchema),
					),
				),
			);
			const verdict = tally(keyed, votes, open);
			kept = verdict.kept;
			fixedIds = verdict.fixed;
		}
		const found = assignIds(capNits(kept), record, roundNumber);
		const fixed: ReviewFinding[] = [];
		for (const finding of record.findings)
			if (finding.status === "open" && fixedIds.has(finding.id)) {
				finding.status = "fixed";
				finding.fixedIn = head;
				fixed.push(finding);
			}
		record.findings.push(...found);
		round.summary = countLine(found);
		if (!scanning) record.rounds.push(round);
		if (file) writeRecord(file, record);
		return {
			record,
			round,
			found,
			fixed,
			passed: blocking(record).length === 0,
			file,
			skipped: null,
		};
	} catch (error) {
		if (!(error instanceof ReviewerError)) throw error;
		return failed(record, round, file, error);
	}
}

function failed(
	record: ReviewRecord,
	round: Round,
	file: string | null,
	error: Error,
): ReviewOutcome {
	round.error = error.message;
	round.summary = "The reviewer could not run.";
	record.rounds.push(round);
	if (file) writeRecord(file, record);
	return {
		record,
		round,
		found: [],
		fixed: [],
		passed: false,
		file,
		skipped: null,
	};
}

function skippedOutcome(
	record: ReviewRecord,
	file: string | null,
	why: string,
): ReviewOutcome {
	return {
		record,
		round: null,
		found: [],
		fixed: [],
		passed: blocking(record).length === 0,
		file,
		skipped: why,
	};
}

export function findersFor(effort: Effort, security: boolean): Focus[] {
	if (effort === "quick") return ["bugs"];
	if (effort === "standard")
		return security ? ["bugs", "security"] : ["bugs", "behavior"];
	return security ? ["bugs", "security", "behavior"] : ["bugs", "behavior"];
}

const pick = <T extends string>(
	value: unknown,
	allowed: readonly T[],
	fallback: T,
): T => (allowed.includes(value as T) ? (value as T) : fallback);

function normalizeCandidate(raw: unknown): Candidate | null {
	if (typeof raw !== "object" || raw === null) return null;
	const entry = raw as Record<string, unknown>;
	if (typeof entry.title !== "string" || entry.title.trim() === "") return null;
	return {
		severity: pick(entry.severity, severities, "nit"),
		category: pick(entry.category, categories, "other"),
		file: typeof entry.file === "string" ? entry.file.replace(/^\.\//, "") : "",
		line:
			typeof entry.line === "number" && entry.line > 0
				? Math.floor(entry.line)
				: 0,
		title: entry.title.trim(),
		detail: typeof entry.detail === "string" ? entry.detail.trim() : "",
		bug_class:
			typeof entry.bug_class === "string" ? entry.bug_class.trim() : "",
	};
}

export function normalizeFinder(raw: unknown): FinderOutput {
	const entry = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
		string,
		unknown
	>;
	return {
		summary: typeof entry.summary === "string" ? entry.summary : "",
		findings: (Array.isArray(entry.findings) ? entry.findings : [])
			.map(normalizeCandidate)
			.filter((candidate): candidate is Candidate => candidate !== null),
		fixed: (Array.isArray(entry.fixed) ? entry.fixed : []).filter(
			(id): id is string => typeof id === "string",
		),
	};
}

export function normalizeVerifier(raw: unknown): VerifierOutput {
	const entry = (typeof raw === "object" && raw !== null ? raw : {}) as Record<
		string,
		unknown
	>;
	const list = (value: unknown) =>
		(Array.isArray(value) ? value : []).filter(
			(item): item is Record<string, unknown> =>
				typeof item === "object" &&
				item !== null &&
				typeof item.id === "string",
		);
	return {
		candidates: list(entry.candidates).map((item) => ({
			id: item.id as string,
			real: item.real === true,
			severity: pick(item.severity, severities, "nit"),
			reason: typeof item.reason === "string" ? item.reason : "",
		})),
		previous: list(entry.previous).map((item) => ({
			id: item.id as string,
			fixed: item.fixed === true,
			reason: typeof item.reason === "string" ? item.reason : "",
		})),
	};
}

const words = (text: string) =>
	new Set(text.toLowerCase().match(/[a-z0-9_]{4,}/g) ?? []);
function similar(
	a: { file: string; line: number; title: string },
	b: { file: string; line: number; title: string },
) {
	if (a.file !== b.file) return false;
	if (Math.abs(a.line - b.line) > 3) return false;
	const left = words(a.title);
	const right = words(b.title);
	const shared = [...left].filter((word) => right.has(word)).length;
	return (
		a.line === b.line || shared >= 2 || Math.min(left.size, right.size) === 0
	);
}

const severityRank: Record<Severity, number> = {
	important: 2,
	"pre-existing": 1,
	nit: 0,
};

/**
 * Drops style findings, merges the same finding from several finders, and
 * drops what earlier rounds already reported, unless it was marked fixed and came back.
 */
export function mergeCandidates(
	candidates: Candidate[],
	previous: ReviewFinding[],
): Candidate[] {
	const merged: Candidate[] = [];
	for (const candidate of candidates) {
		if (candidate.category === "style") continue;
		if (
			previous.some(
				(finding) => finding.status !== "fixed" && similar(finding, candidate),
			)
		)
			continue;
		const twin = merged.find((existing) => similar(existing, candidate));
		if (!twin) merged.push(candidate);
		else if (severityRank[candidate.severity] > severityRank[twin.severity])
			twin.severity = candidate.severity;
	}
	return merged;
}

/** A candidate stays when a majority of verifiers confirm it; same for an earlier finding being fixed. */
export function tally(
	candidates: (Candidate & { key: string })[],
	votes: VerifierOutput[],
	open: ReviewFinding[],
): { kept: Candidate[]; fixed: Set<string> } {
	const needed = Math.floor(votes.length / 2) + 1;
	const kept: Candidate[] = [];
	for (const { key, ...candidate } of candidates) {
		const real = votes
			.map((vote) => vote.candidates.find((entry) => entry.id === key))
			.filter((entry) => entry?.real === true);
		if (real.length < needed) continue;
		const counts = new Map<Severity, number>();
		for (const entry of real)
			if (entry)
				counts.set(entry.severity, (counts.get(entry.severity) ?? 0) + 1);
		const severity =
			[...counts].sort(
				(a, b) => b[1] - a[1] || severityRank[b[0]] - severityRank[a[0]],
			)[0]?.[0] ?? candidate.severity;
		kept.push({ ...candidate, severity });
	}
	const fixed = new Set(
		open
			.filter(
				(finding) =>
					votes.filter(
						(vote) =>
							vote.previous.find((entry) => entry.id === finding.id)?.fixed ===
							true,
					).length >= needed,
			)
			.map((finding) => finding.id),
	);
	return { kept, fixed };
}

function capNits(candidates: Candidate[]) {
	let nits = 0;
	return candidates.filter(
		(candidate) => candidate.severity !== "nit" || ++nits <= maxNits,
	);
}

function assignIds(
	candidates: Candidate[],
	record: ReviewRecord,
	round: number,
): ReviewFinding[] {
	const used = record.findings
		.map((finding) => Number(finding.id.slice(1)))
		.filter(Number.isFinite);
	let next = Math.max(0, ...used) + 1;
	const order = (candidate: Candidate) => -severityRank[candidate.severity];
	return [...candidates]
		.sort((a, b) => order(a) - order(b))
		.map((candidate) => ({
			...candidate,
			id: `f${next++}`,
			round,
			status: "open" as const,
			answer: null,
			fixedIn: null,
		}));
}

export function countLine(findings: Candidate[]) {
	const count = (severity: Severity) =>
		findings.filter((finding) => finding.severity === severity).length;
	const important = count("important");
	const nits = count("nit");
	const old = count("pre-existing");
	if (findings.length === 0) return "0 findings. Nothing to fix.";
	return `${important} important, ${nits} nit${nits === 1 ? "" : "s"}, ${old} pre-existing.`;
}
