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
	answerHint,
	holdsOnError,
	type Reach,
	reachFrom,
	unresolved,
} from "./gate";
import {
	type FinderOutput,
	type Focus,
	finderPrompt,
	finderSchema,
	findingsToVerify,
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
	cycleStart,
	discoveryRounds,
	type ReviewFinding,
	type ReviewRecord,
	type Round,
	type Severity,
	severities,
} from "./types";

/** A problem with the repo state, not with cagr: the message says what to do. */
export class ReviewInputError extends Error {}

export type ReviewOptions = {
	cwd: string;
	base?: string;
	/** Review the whole branch in a full round, even if it was reviewed. Starts a new cycle. */
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
	/** Important findings not closed at the reviewed head, including fixes judged on a commit it does not contain. */
	open: ReviewFinding[];
	passed: boolean;
	file: string | null;
	/** Set when there was nothing to review, with why. */
	skipped: string | null;
	/** Why open Important findings were not judged again in this run. */
	held: string[];
};

const maxDiff = 150_000;
const maxNits = 3;
/** Verdicts an open finding may get. Past this, an answer is the only way to close it. */
export const maxVerdicts = 3;

async function gitOut(args: string[], cwd: string) {
	const result = await run(["git", ...args], cwd);
	if (!result.ok)
		throw new ReviewInputError(
			`git ${args.join(" ")} failed: ${result.output.trim()}`,
		);
	return result.stdout.trimEnd();
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

export async function review(
	config: Config,
	options: ReviewOptions,
): Promise<ReviewOutcome> {
	const progress = options.progress ?? (() => {});
	const now = options.now ?? (() => new Date());
	const git = await gitContext(options.cwd);
	if (!git.toplevel || !git.commonDir || !git.head)
		throw new ReviewInputError(
			"Run `cagr review` inside a git repo with at least one commit.",
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
	let from = head;
	let mergeBase = head;
	let scope: Round["scope"] = "scan";
	let recheckBefore: number | null = null;
	let branchFiles: string[] = [];
	const reach: Reach = scanning
		? () => false
		: await reachFrom(record, head, cwd);
	const openNow = () =>
		scanning ? blocking(record) : unresolved(record, head, reach);
	const held = scanning
		? new Map<string, string>()
		: await heldBack(record, head, config.review.skip, cwd);
	// After a failed round the gate holds only what `holdsOnError` keeps, so the report and CI say the same.
	const openAfterError = async () => {
		if (scanning) return blocking(record);
		const after = await reachFrom(record, head, cwd);
		return unresolved(record, head, after).filter((finding) =>
			holdsOnError(finding, after),
		);
	};
	const heldLines = () =>
		openNow().flatMap((finding) => {
			const why = held.get(finding.id);
			return why ? [why] : [];
		});
	if (!scanning) {
		const baseRef = await resolveBase(baseName, cwd);
		mergeBase = await gitOut(["merge-base", baseRef, head], cwd);
		if (mergeBase === head)
			return skippedOutcome(
				record,
				file,
				openNow(),
				`No commits on ${branch} beyond ${baseName}, so there is nothing to review.`,
			);
		const plan = await planRound(record, {
			head,
			mergeBase,
			full: options.full === true,
			maxRounds: config.review.max_rounds,
			reach,
			held,
			cwd,
			progress,
		});
		if (typeof plan === "string")
			return skippedOutcome(record, file, openNow(), plan);
		({ from, scope, recheckBefore } = plan);
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
				[
					"log",
					"--no-merges",
					"--format=- %s%n%b",
					`${from}..${head}`,
					`^${mergeBase}`,
				],
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
		log,
		diff,
		guide: existsSync(guidePath) ? readFileSync(guidePath, "utf8") : null,
		skip: config.review.skip,
		scan: options.scan ?? [],
		previous: record.findings,
		cycleStart: scope === "full" ? roundNumber : cycleStart(record),
		recheckBefore,
		stale: unresolved(record, head, reach)
			.filter((finding) => finding.status === "fixed")
			.map((finding) => finding.id),
		spent: record.findings
			.filter(
				(finding) => held.has(finding.id) || judgedAt(record, finding, head),
			)
			.map((finding) => finding.id),
		capped:
			scope !== "full" &&
			scope !== "scan" &&
			discoveryRounds(record) >= config.review.max_rounds,
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
		verified: [],
	};
	let agent: ReviewAgent;
	try {
		agent = options.agent ?? pickAgent(config.review.reviewer);
	} catch (error) {
		return failed(record, round, file, openAfterError, error as Error);
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
		// An empty diff (empty commits, or only skipped files) gives finders nothing to read.
		const focuses =
			scope === "verify" || (scope === "diff" && diff === "")
				? []
				: findersFor(effort, config.review.security);
		progress(
			scope === "verify"
				? "Running only the verifier on earlier findings."
				: `Reviewing ${scope === "diff" ? "the new commits" : scope === "scan" ? `${reviewed.length} files` : branch} with ${agent.name}: ${effort} effort, ${risk.tier} risk, ${focuses.length} finder${focuses.length === 1 ? "" : "s"}.`,
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
		const previous = findingsToVerify(context);
		const verifiers =
			effort === "deep"
				? 3
				: effort === "standard" || scope === "verify" || previous.length > 0
					? 1
					: 0;
		let kept = candidates;
		let fixedIds = new Set<string>();
		if (
			scope === "verify" ||
			(verifiers > 0 &&
				((effort !== "quick" && candidates.length > 0) || previous.length > 0))
		) {
			progress(
				`Checking ${candidates.length} candidate finding${candidates.length === 1 ? "" : "s"} and ${previous.length} earlier finding${previous.length === 1 ? "" : "s"} with ${verifiers} verifier${verifiers === 1 ? "" : "s"}.`,
			);
			const keyed = (effort === "quick" ? [] : candidates).map(
				(candidate, index) => ({
					...candidate,
					key: `C${index + 1}`,
				}),
			);
			const votes = await Promise.all(
				Array.from({ length: verifiers }, async () =>
					normalizeVerifier(
						await ask(verifierPrompt(context, keyed), verifierSchema),
					),
				),
			);
			round.verified = previous.map((finding) => finding.id);
			const verdict = tally(keyed, votes, previous);
			if (effort !== "quick") kept = verdict.kept;
			fixedIds = verdict.fixed;
		}
		const found = assignIds(capNits(kept), record, roundNumber);
		const fixed: ReviewFinding[] = [];
		for (const finding of previous) {
			if (finding.status === "open")
				finding.verdicts = (finding.verdicts ?? 0) + 1;
			if (finding.status === "open" && fixedIds.has(finding.id)) {
				finding.status = "fixed";
				finding.fixedIn = head;
				fixed.push(finding);
			} else if (
				context.stale.includes(finding.id) &&
				fixedIds.has(finding.id)
			) {
				// Confirmed on history the old fix commit is not part of, so this head is the fix commit now.
				finding.fixedIn = head;
			} else if (finding.status === "fixed" && !fixedIds.has(finding.id)) {
				// A reopened finding needs a new fix, so it gets a fresh count of verdicts.
				finding.status = "open";
				finding.fixedIn = null;
				finding.verdicts = 0;
			}
		}
		record.findings.push(...found);
		round.summary =
			scope === "verify" ? "Checked earlier findings." : countLine(found);
		if (!scanning) record.rounds.push(round);
		const open = openNow();
		if (file) writeRecord(file, record);
		return {
			record,
			round,
			found,
			fixed,
			open,
			passed: open.length === 0,
			file,
			skipped: null,
			held: heldLines(),
		};
	} catch (error) {
		if (!(error instanceof ReviewerError)) throw error;
		return failed(record, round, file, openAfterError, error);
	}
}

type PlanInput = {
	head: string;
	mergeBase: string;
	full: boolean;
	maxRounds: number;
	reach: Reach;
	/** Open findings the verifier may not judge at this head, with why. */
	held: Map<string, string>;
	cwd: string;
	progress: (line: string) => void;
};

type Plan = {
	from: string;
	scope: Round["scope"];
	recheckBefore: number | null;
};

/**
 * Whether the verifier may not judge `finding` again at `head`. A finding
 * reported at this commit needs a fix or an answer, so it is never judged
 * here. Otherwise it gets two verdicts per commit: the first review there and
 * one recheck.
 */
function judgedAt(record: ReviewRecord, finding: ReviewFinding, head: string) {
	const ran = record.rounds.filter(
		(round) => !round.error && round.head === head,
	);
	return (
		ran.some((round) => round.n === finding.round) ||
		ran.filter((round) => round.verified?.includes(finding.id)).length >= 2
	);
}

/**
 * Open findings the verifier may not judge at `head`, each with why. A verdict
 * on unchanged code is only a reroll of the model, so a finding is judged
 * again only when a commit since its last verdict (or since the round that
 * reported it) changed a reviewed file, and at most `maxVerdicts` times. Any
 * file counts, not only the finding's: a fix can be a new test or a change in
 * a caller, and the cap bounds the rest. A recheck at the commit of its last
 * verdict is left to `judgedAt`. A git error leaves the finding to the verifier.
 */
async function heldBack(
	record: ReviewRecord,
	head: string,
	skip: string[],
	cwd: string,
) {
	const held = new Map<string, string>();
	await Promise.all(
		record.findings
			.filter((finding) => finding.status === "open")
			.map(async (finding) => {
				if ((finding.verdicts ?? 0) >= maxVerdicts) {
					held.set(
						finding.id,
						`${finding.id} is still open: the verifier judged it ${maxVerdicts} times, the most it may. Answer it with ${answerCommand(finding.id)}.`,
					);
					return;
				}
				const last = record.rounds.findLast(
					(round) =>
						!round.error &&
						(round.n === finding.round || round.verified?.includes(finding.id)),
				);
				if (!last || last.head === head) return;
				const unchanged = await run(
					[
						"git",
						"diff",
						"--quiet",
						last.head,
						head,
						"--",
						".",
						...skip.map((glob) => `:(exclude,glob)${glob}`),
					],
					cwd,
				);
				if (unchanged.ok)
					held.set(
						finding.id,
						`${finding.id} is still open: no commit since the last check changed any reviewed file, so the verifier does not judge it again. Fix it${finding.file ? ` (${finding.file})` : ""}, or answer it with ${answerCommand(finding.id)}.`,
					);
			}),
	);
	return held;
}

const answerCommand = (id: string) =>
	`\`cagr review answer ${id} --wrong "<why>"\` (or --intentional, or --minor)`;

/**
 * Picks what the next round covers, or returns why there is nothing to do.
 * New commits always get finders on their diff, before and past the round
 * cap: the cap only stops further full rounds.
 */
async function planRound(
	record: ReviewRecord,
	input: PlanInput,
): Promise<Plan | string> {
	const { head, mergeBase, cwd, progress } = input;
	const fresh = {
		from: mergeBase,
		scope: "full" as const,
		recheckBefore: null,
	};
	const lastOk = record.rounds.findLast((round) => !round.error);
	if (input.full || !lastOk) return fresh;
	const short = lastOk.head.slice(0, 7);
	if (
		!(await run(["git", "cat-file", "-e", `${lastOk.head}^{commit}`], cwd)).ok
	) {
		progress(
			`The last reviewed commit ${short} is gone (amended, rebased or garbage-collected), so this starts a new cycle with a full review.`,
		);
		return fresh;
	}
	if (
		!(await run(["git", "merge-base", "--is-ancestor", lastOk.head, head], cwd))
			.ok
	) {
		progress(
			`The last reviewed commit ${short} is not in this branch's history (a rebase or a reused branch name), so this starts a new cycle with a full review.`,
		);
		return fresh;
	}
	if (lastOk.head === head) {
		// A verifier can be wrong about an earlier finding, so it may look once
		// more. Findings reported at this commit need a fix or an answer, so the
		// boundary is the first round that reviewed it, not the latest recheck.
		let first = lastOk;
		for (const round of record.rounds.toReversed()) {
			if (round.error) continue;
			if (round.head !== head) break;
			first = round;
		}
		const earlier = unresolved(record, head, input.reach).filter(
			(finding) => finding.round < first.n,
		);
		if (earlier.length === 0)
			return `${head.slice(0, 7)} was already reviewed in round ${lastOk.n}.`;
		const why = earlier.flatMap((finding) => {
			const reason = input.held.get(finding.id);
			return reason ? [reason] : [];
		});
		const spent = earlier.filter(
			(finding) =>
				!input.held.has(finding.id) && judgedAt(record, finding, head),
		);
		if (why.length + spent.length === earlier.length) {
			if (spent.length > 0) {
				const ids = spent.map((finding) => finding.id).join(", ");
				why.push(
					`The verifier already judged ${ids} at ${head.slice(0, 7)} as often as it may, so \`cagr review\` does not judge ${spent.length === 1 ? "it" : "them"} again at this commit. Commit a fix and run \`cagr review\`. ${answerHint(spent[0]?.id ?? "f1")}`,
				);
			}
			return why.join("\n");
		}
		return { from: first.from, scope: "verify", recheckBefore: first.n };
	}
	if (discoveryRounds(record) >= input.maxRounds)
		progress(
			`Reached the ${input.maxRounds}-round cap, so no further full round runs: finders review the new commits, and the verifier checks earlier findings.`,
		);
	return { from: lastOk.head, scope: "diff", recheckBefore: null };
}

async function failed(
	record: ReviewRecord,
	round: Round,
	file: string | null,
	openAfter: () => Promise<ReviewFinding[]>,
	error: Error,
): Promise<ReviewOutcome> {
	round.error = error.message;
	round.summary = "The reviewer could not run.";
	record.rounds.push(round);
	if (file) writeRecord(file, record);
	return {
		record,
		round,
		found: [],
		fixed: [],
		open: await openAfter(),
		passed: false,
		file,
		skipped: null,
		held: [],
	};
}

function skippedOutcome(
	record: ReviewRecord,
	file: string | null,
	open: ReviewFinding[],
	why: string,
): ReviewOutcome {
	return {
		record,
		round: null,
		found: [],
		fixed: [],
		open,
		passed: open.length === 0,
		file,
		skipped: why,
		held: [],
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
	// Line 0 means "no line", so two findings there are the same only when their titles agree.
	const sameLine = a.line > 0 && a.line === b.line;
	return sameLine || shared >= 2;
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
