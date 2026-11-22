import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveConfig } from "../config/load";
import { tempRepo } from "../test/repo";
import { type AgentRequest, type ReviewAgent, ReviewerError } from "./agent";
import { gateResult, reachFrom } from "./gate";
import { finderSchema, verifierSchema } from "./prompt";
import { reviewReport } from "./report";
import {
	findersFor,
	mergeCandidates,
	normalizeFinder,
	ReviewInputError,
	review,
	tally,
} from "./review";
import { type Candidate, discoveryRounds, type ReviewFinding } from "./types";

const candidate = (extra: Partial<Candidate> = {}): Candidate => ({
	severity: "important",
	category: "bug",
	file: "src/a.ts",
	line: 10,
	title: "Null user crashes the handler",
	detail: "user is undefined when the session expired",
	bug_class: "",
	...extra,
});

const finding = (extra: Partial<ReviewFinding> = {}): ReviewFinding => ({
	...candidate(),
	id: "f1",
	round: 1,
	status: "open",
	answer: null,
	fixedIn: null,
	...extra,
});

/** A reviewer that answers from a script: finders and verifiers get their own replies. */
function fakeAgent(replies: {
	finder: (request: AgentRequest, call: number) => unknown;
	verifier?: (request: AgentRequest, call: number) => unknown;
}) {
	const calls: AgentRequest[] = [];
	let finders = 0;
	let verifiers = 0;
	const agent: ReviewAgent = {
		name: "fake",
		async ask(request) {
			calls.push(request);
			if (request.schema === finderSchema)
				return replies.finder(request, finders++);
			return (replies.verifier ?? (() => ({ candidates: [], previous: [] })))(
				request,
				verifiers++,
			);
		},
	};
	return { agent, calls };
}

async function branchRepo() {
	const repo = await tempRepo();
	await repo.git("checkout", "-q", "-b", "feat/login");
	await repo.commit(
		"feat(auth): add login\n\nDeliberately use an optional display name.",
		{
			"src/a.ts": "export const login = (user) => user.name;\n",
		},
	);
	const config = resolveConfig(
		{ review: { enabled: true } },
		repo.root,
		join(repo.root, "cagr.toml"),
	);
	return { ...repo, config };
}

describe("review", () => {
	test("standard effort runs a bug and a security finder, then one verifier that keeps real findings", async () => {
		const repo = await branchRepo();
		const { agent, calls } = fakeAgent({
			finder: (_, call) => ({
				summary: "1 important.",
				findings:
					call === 0
						? [candidate()]
						: [candidate({ title: "Login has no rate limit", line: 1 })],
				fixed: [],
			}),
			verifier: () => ({
				candidates: [
					{ id: "C1", real: true, severity: "important", reason: "yes" },
					{ id: "C2", real: false, severity: "nit", reason: "speculative" },
				],
				previous: [],
			}),
		});
		const outcome = await review(repo.config, { cwd: repo.root, agent });
		expect(calls).toHaveLength(3);
		expect(calls[0]?.prompt).toContain("Correctness");
		expect(calls[1]?.prompt).toContain("Security");
		expect(calls[0]?.prompt).toContain("feat(auth): add login");
		expect(calls[0]?.prompt).toContain("+export const login");
		for (const call of calls) {
			expect(call.prompt).toContain(
				"requires a concrete failing input or state and its consequence",
			);
			expect(call.prompt).toContain(
				"Do not report a choice the commit body names as deliberate",
			);
			expect(call.prompt).toContain(
				"Deliberately use an optional display name.",
			);
		}
		expect(calls[0]?.prompt).toContain(
			"This is the only full review. Later rounds see only the commits added after it",
		);
		expect(reviewReport(outcome, 2)).toContain("covering the whole bug class");
		expect(reviewReport(outcome, 2)).toContain("Run the targeted tests");
		expect(outcome.found.map((entry) => entry.title)).toEqual([
			"Null user crashes the handler",
		]);
		expect(outcome.found[0]?.id).toBe("f1");
		expect(outcome.passed).toBe(false);
		expect(outcome.file && existsSync(outcome.file)).toBe(true);
		expect(outcome.file).toContain(join(".git", "cagr", "reviews"));
	});

	test("round 2 reviews only the new commits, marks fixed findings, and passes", async () => {
		const repo = await branchRepo();
		const first = fakeAgent({
			finder: () => ({ summary: "", findings: [candidate()], fixed: [] }),
			verifier: () => ({
				candidates: [
					{ id: "C1", real: true, severity: "important", reason: "" },
				],
				previous: [],
			}),
		});
		const round1 = await review(repo.config, {
			cwd: repo.root,
			agent: first.agent,
		});
		const head1 = round1.round?.head ?? "";
		await repo.commit(
			"fix(auth): handle a missing user\n\nReturn undefined for an expired session.",
			{
				"src/a.ts": "export const login = (user) => user?.name;\n",
			},
		);
		const second = fakeAgent({
			finder: () => ({ summary: "0 findings.", findings: [], fixed: ["f1"] }),
			verifier: () => ({
				candidates: [],
				previous: [{ id: "f1", fixed: true, reason: "optional chain" }],
			}),
		});
		const round2 = await review(repo.config, {
			cwd: repo.root,
			agent: second.agent,
		});
		expect(round2.round?.scope).toBe("diff");
		expect(round2.round?.from).toBe(head1);
		const prompt = second.calls[0]?.prompt ?? "";
		expect(prompt).toContain("only the commits added since the last review");
		expect(prompt).toContain("Already reported in earlier rounds");
		expect(prompt).toContain("user?.name");
		expect(prompt).not.toContain("feat(auth): add login");
		expect(round2.fixed.map((entry) => entry.id)).toEqual(["f1"]);
		expect(round2.passed).toBe(true);
		expect(reviewReport(round2, 3)).toContain("Fixed since the last round");
	});

	test("past the cap, a commit that fixes a finding still gets finders on its diff, and what they find blocks", async () => {
		const { repo, options, second } = await cappedWithFinding();
		const sha = await repo.commit(
			"fix: handle an expired session\n\nAlso add a command runner.",
			{
				"src/a.ts":
					"export const login = (user) => user?.name;\nexport const run = (cmd) => Bun.spawn(['sh', '-c', cmd]);\n",
			},
		);
		const { agent, calls } = fakeAgent({
			finder: () => ({
				findings: [
					candidate({
						category: "security",
						line: 2,
						title: "Shell injection through run",
					}),
				],
			}),
			verifier: () => ({ previous: [{ id: "f1", fixed: true }] }),
		});
		const progress: string[] = [];
		const outcome = await review(repo.config, {
			...options,
			agent,
			progress: (line) => progress.push(line),
		});
		expect(outcome.round?.scope).toBe("diff");
		expect(outcome.round?.from).toBe(second.round?.head ?? "");
		expect(calls.map((call) => call.schema)).toEqual([
			finderSchema,
			verifierSchema,
		]);
		expect(calls[0]?.prompt).toContain("+export const run");
		expect(calls[0]?.prompt).not.toContain("feat(auth): add login");
		expect(progress.join("\n")).toContain("no further full round");
		expect(outcome.fixed.map((entry) => entry.id)).toEqual(["f1"]);
		expect(outcome.found.map((entry) => entry.id)).toEqual(["f2"]);
		expect(outcome.passed).toBe(false);
		const gate = gateResult(outcome.record, sha, repo.config);
		expect(gate.kind === "deny" && gate.reason).toContain("f2 src/a.ts:2");
	});

	test("rechecking a later commit can reopen a regressed fix, which then fails the earlier head too", async () => {
		const repo = await branchRepo();
		const { agent } = fakeAgent({
			finder: (_, call) => ({ findings: call === 0 ? [candidate()] : [] }),
			verifier: (_, call) => ({ previous: [{ id: "f1", fixed: call === 0 }] }),
		});
		const options = { cwd: repo.root, agent, effort: "quick" as const };
		await review(repo.config, options);
		const fixed = await repo.commit("fix: allow an expired session", {
			"src/a.ts": "user?.name\n",
		});
		expect((await review(repo.config, options)).passed).toBe(true);
		const reverted = await repo.commit(
			"revert: restore the old session handling",
			{ "src/a.ts": "user.name\n" },
		);
		const outcome = await review(repo.config, options);
		expect(outcome.passed).toBe(false);
		expect(gateResult(outcome.record, reverted, repo.config).kind).toBe("deny");
		expect(gateResult(outcome.record, fixed, repo.config).kind).toBe("deny");
	});

	/** Two clean rounds reach the default cap of 2. */
	async function cappedRepo() {
		const repo = await branchRepo();
		const clean = fakeAgent({ finder: () => ({ findings: [] }) });
		const options = { cwd: repo.root, effort: "quick" as const };
		await review(repo.config, { ...options, agent: clean.agent });
		await repo.commit("feat(auth): log the login", {
			"src/a.ts": "export const login = (user) => user?.name;\n",
		});
		const second = await review(repo.config, {
			...options,
			agent: clean.agent,
		});
		expect(second.round?.scope).toBe("diff");
		return { repo, options, capHead: second.round?.head ?? "" };
	}

	test("past the cap, a commit that is not a fix commit still gets finders on the new commits", async () => {
		const { repo, options, capHead } = await cappedRepo();
		const sha = await repo.commit("feat(auth): add logout", {
			"src/logout.ts": "export const logout = (user) => user.end();\n",
		});
		const { agent, calls } = fakeAgent({
			finder: () => ({
				findings: [
					candidate({
						file: "src/logout.ts",
						line: 1,
						title: "Logout crashes",
					}),
				],
			}),
		});
		const progress: string[] = [];
		const outcome = await review(repo.config, {
			...options,
			agent,
			progress: (line) => progress.push(line),
		});
		expect(outcome.round?.scope).toBe("diff");
		expect(outcome.round?.from).toBe(capHead);
		expect(calls.map((call) => call.schema)).toEqual([finderSchema]);
		expect(calls[0]?.prompt).toContain("+export const logout");
		expect(calls[0]?.prompt).not.toContain("+export const login");
		expect(progress.join("\n")).toContain("finders review the new commits");
		expect(outcome.passed).toBe(false);
		expect(gateResult(outcome.record, sha, repo.config).kind).toBe("deny");
	});

	/** Round 1 reports f1 in src/a.ts, round 2 leaves it open: the cap of 2 is reached. */
	async function cappedWithFinding() {
		const repo = await branchRepo();
		const { agent } = fakeAgent({
			finder: (_, call) => ({ findings: call === 0 ? [candidate()] : [] }),
			verifier: () => ({ previous: [{ id: "f1", fixed: false }] }),
		});
		const options = { cwd: repo.root, effort: "quick" as const };
		await review(repo.config, { ...options, agent });
		await repo.commit("fix: first attempt", { "src/a.ts": "broken\n" });
		const second = await review(repo.config, { ...options, agent });
		expect(second.passed).toBe(false);
		return { repo, options, second };
	}

	test("a recheck at the same head verifies only findings from earlier rounds", async () => {
		const repo = await branchRepo();
		const { agent } = fakeAgent({
			finder: (_, call) => ({
				findings:
					call === 0
						? [candidate()]
						: [
								candidate({
									file: "src/b.ts",
									line: 1,
									title: "Other bug here",
								}),
							],
			}),
			verifier: () => ({ previous: [{ id: "f1", fixed: false }] }),
		});
		const options = { cwd: repo.root, effort: "quick" as const };
		await review(repo.config, { ...options, agent });
		await repo.commit("fix: first attempt", {
			"src/a.ts": "broken\n",
			"src/b.ts": "other\n",
		});
		const second = await review(repo.config, { ...options, agent });
		expect(second.found.map((entry) => entry.id)).toEqual(["f2"]);
		const recheck = async (f1Fixed: boolean) => {
			const next = fakeAgent({
				finder: () => ({ findings: [] }),
				verifier: () => ({
					previous: [
						{ id: "f1", fixed: f1Fixed },
						{ id: "f2", fixed: true },
					],
				}),
			});
			const outcome = await review(repo.config, {
				...options,
				agent: next.agent,
			});
			const prompt = next.calls[0]?.prompt ?? "";
			expect(prompt).toContain("already reviewed");
			expect(prompt).toContain("f1 src/a.ts");
			expect(prompt).not.toContain("f2 src/b.ts");
			return outcome;
		};
		const outcome = await recheck(false);
		expect(outcome.round?.scope).toBe("verify");
		expect(
			outcome.record.findings.map((entry) => [entry.id, entry.status]),
		).toEqual([
			["f1", "open"],
			["f2", "open"],
		]);
		expect(reviewReport(outcome, 3)).not.toContain("round cap");
		// A second recheck would only re-roll the verifier, so it is refused.
		const refused = fakeAgent({
			finder: () => {
				throw new Error("A refused recheck runs no finders");
			},
			verifier: () => {
				throw new Error("A refused recheck runs no verifier");
			},
		});
		const again = await review(repo.config, {
			...options,
			agent: refused.agent,
		});
		expect(again.skipped).toContain("Commit a fix");
		expect(again.skipped).toContain("cagr review answer f1");
		expect(refused.calls).toEqual([]);
		// --full still runs, but the verifier judges neither f1 (spent here) nor f2 (reported here).
		const full = fakeAgent({
			finder: () => ({ findings: [] }),
			verifier: () => ({ previous: [{ id: "f1", fixed: true }] }),
		});
		const forced = await review(repo.config, {
			...options,
			agent: full.agent,
			full: true,
		});
		expect(forced.round?.scope).toBe("full");
		expect(full.calls.map((call) => call.schema)).toEqual([finderSchema]);
		expect(
			forced.record.findings.find((entry) => entry.id === "f1")?.status,
		).toBe("open");
		expect(forced.passed).toBe(false);
	});

	test("a finding is never judged at the commit that reported it, even by --full or after a reset", async () => {
		const repo = await branchRepo();
		const { agent } = fakeAgent({
			finder: (_, call) => ({ findings: call === 0 ? [candidate()] : [] }),
			verifier: () => ({ previous: [{ id: "f1", fixed: false }] }),
		});
		const options = { cwd: repo.root, effort: "quick" as const };
		const first = await review(repo.config, { ...options, agent });
		const reported = first.round?.head ?? "";
		const lenient = fakeAgent({
			finder: () => ({ findings: [] }),
			verifier: () => ({ previous: [{ id: "f1", fixed: true }] }),
		});
		const forced = await review(repo.config, {
			...options,
			agent: lenient.agent,
			full: true,
		});
		expect(forced.round?.scope).toBe("full");
		expect(forced.passed).toBe(false);
		await repo.commit("fix: first attempt", { "src/a.ts": "broken\n" });
		expect((await review(repo.config, { ...options, agent })).passed).toBe(
			false,
		);
		await repo.git("reset", "-q", "--hard", reported);
		const reset = await review(repo.config, {
			...options,
			agent: lenient.agent,
		});
		expect(reset.round?.scope).toBe("full");
		expect(reset.passed).toBe(false);
		expect(lenient.calls.map((call) => call.schema)).toEqual([
			finderSchema,
			finderSchema,
		]);
		const again = await review(repo.config, {
			...options,
			agent: lenient.agent,
		});
		expect(again.skipped).toContain("Commit a fix");
		expect(again.passed).toBe(false);
	});

	test("past the cap, a finder round still verifies open nits", async () => {
		const repo = await branchRepo();
		const { agent } = fakeAgent({
			finder: (_, call) => ({
				findings: call === 0 ? [candidate({ severity: "nit" })] : [],
			}),
		});
		const options = { cwd: repo.root, effort: "quick" as const };
		await review(repo.config, { ...options, agent });
		await repo.commit("feat: more", { "src/c.ts": "c\n" });
		await review(repo.config, { ...options, agent });
		await repo.commit("feat: tidy", { "src/a.ts": "user?.name\n" });
		const next = fakeAgent({
			finder: () => ({ findings: [] }),
			verifier: () => ({ previous: [{ id: "f1", fixed: true }] }),
		});
		const outcome = await review(repo.config, {
			...options,
			agent: next.agent,
		});
		expect(outcome.round?.scope).toBe("diff");
		expect(outcome.fixed.map((entry) => entry.id)).toEqual(["f1"]);
	});

	test("a rebased branch starts a new cycle with a full round", async () => {
		const { repo, options } = await cappedRepo();
		await repo.git(
			"commit",
			"-q",
			"--amend",
			"-m",
			"feat(auth): log the login again",
		);
		const { agent, calls } = fakeAgent({ finder: () => ({ findings: [] }) });
		const progress: string[] = [];
		const outcome = await review(repo.config, {
			...options,
			agent,
			progress: (line) => progress.push(line),
		});
		const mergeBase = await repo.git("merge-base", "main", "HEAD");
		expect(outcome.round?.scope).toBe("full");
		expect(outcome.round?.from).toBe(mergeBase);
		expect(calls.map((call) => call.schema)).toEqual([finderSchema]);
		expect(progress.join("\n")).toContain("not in this branch's history");
		expect(discoveryRounds(outcome.record)).toBe(1);
	});

	test("after a rebase, the full round checks again a fix judged on the old history", async () => {
		const repo = await branchRepo();
		const { agent } = fakeAgent({
			finder: (_, call) => ({ findings: call === 0 ? [candidate()] : [] }),
			verifier: () => ({ previous: [{ id: "f1", fixed: true }] }),
		});
		const options = { cwd: repo.root, effort: "quick" as const };
		await review(repo.config, { ...options, agent });
		await repo.commit("fix: handle the session", {
			"src/a.ts": "user?.name\n",
		});
		expect((await review(repo.config, { ...options, agent })).passed).toBe(
			true,
		);
		await repo.git("commit", "-q", "--amend", "-m", "fix: handle a session");
		const next = fakeAgent({
			finder: () => ({ findings: [] }),
			verifier: () => ({ previous: [{ id: "f1", fixed: true }] }),
		});
		const outcome = await review(repo.config, {
			...options,
			agent: next.agent,
		});
		expect(outcome.round?.scope).toBe("full");
		expect(next.calls.at(-1)?.schema).toBe(verifierSchema);
		expect(next.calls.at(-1)?.prompt).toContain("f1 src/a.ts");
		expect(outcome.record.findings[0]?.fixedIn).toBe(outcome.round?.head ?? "");
		expect(outcome.passed).toBe(true);
	});

	test("a reused branch name starts a new cycle with a full round", async () => {
		const { repo, options } = await cappedRepo();
		await repo.git("checkout", "-q", "main");
		await repo.git("merge", "-q", "--squash", "feat/login");
		await repo.git("commit", "-q", "-m", "feat(auth): add login (#1)");
		await repo.git("branch", "-q", "-D", "feat/login");
		await repo.git("checkout", "-q", "-b", "feat/login");
		await repo.commit("feat(auth): add signup", {
			"src/signup.ts": "export const signup = (user) => user.id;\n",
		});
		const { agent, calls } = fakeAgent({ finder: () => ({ findings: [] }) });
		const outcome = await review(repo.config, { ...options, agent });
		expect(outcome.round?.scope).toBe("full");
		expect(calls.map((call) => call.schema)).toEqual([finderSchema]);
		expect(calls[0]?.prompt).toContain("+export const signup");
	});

	test("a last reviewed commit that was garbage-collected starts a new cycle", async () => {
		const { repo, options } = await cappedRepo();
		await repo.git(
			"commit",
			"-q",
			"--amend",
			"-m",
			"feat(auth): log the login again",
		);
		await repo.git("reflog", "expire", "--expire=now", "--all");
		await repo.git("gc", "-q", "--prune=now");
		const { agent, calls } = fakeAgent({ finder: () => ({ findings: [] }) });
		const progress: string[] = [];
		const outcome = await review(repo.config, {
			...options,
			agent,
			progress: (line) => progress.push(line),
		});
		expect(outcome.round?.scope).toBe("full");
		expect(calls.map((call) => call.schema)).toEqual([finderSchema]);
		expect(progress.join("\n")).toContain("is gone");
	});

	test("--full forces a full round, even at a reviewed head", async () => {
		const { repo, options } = await cappedRepo();
		const { agent, calls } = fakeAgent({ finder: () => ({ findings: [] }) });
		const outcome = await review(repo.config, {
			...options,
			agent,
			full: true,
		});
		expect(outcome.skipped).toBeNull();
		expect(outcome.round?.scope).toBe("full");
		expect(calls.map((call) => call.schema)).toEqual([finderSchema]);
		expect(calls[0]?.prompt).toContain("+export const login");
	});

	test("the same head can be verified again when an earlier finding is still open", async () => {
		const repo = await branchRepo();
		const { agent } = fakeAgent({
			finder: (_, call) => ({ findings: call === 0 ? [candidate()] : [] }),
			verifier: () => ({ previous: [{ id: "f1", fixed: false }] }),
		});
		const options = { cwd: repo.root, effort: "quick" as const };
		const first = await review(repo.config, { ...options, agent });
		expect(
			(await review(repo.config, { ...options, agent })).skipped,
		).toContain("already reviewed");
		await repo.commit("fix: handle the session", {
			"src/a.ts": "user?.name\n",
		});
		const second = await review(repo.config, { ...options, agent });
		expect(second.passed).toBe(false);
		const again = fakeAgent({
			finder: () => {
				throw new Error("A recheck runs no finders");
			},
			verifier: () => ({ previous: [{ id: "f1", fixed: true }] }),
		});
		const outcome = await review(repo.config, {
			...options,
			agent: again.agent,
		});
		expect(outcome.skipped).toBeNull();
		expect(outcome.round?.scope).toBe("verify");
		expect(outcome.round?.from).toBe(first.round?.head ?? "");
		expect(again.calls.map((call) => call.schema)).toEqual([verifierSchema]);
		expect(outcome.passed).toBe(true);
	});

	test("the commit log leaves out merges and is cut at 6000 characters", async () => {
		const repo = await branchRepo();
		await repo.git("checkout", "-q", "-b", "side", "main");
		await repo.commit("chore: side", { "side.txt": "side\n" });
		await repo.git("checkout", "-q", "feat/login");
		await repo.git("merge", "-q", "--no-ff", "-m", "Merge branch side", "side");
		await repo.commit(`docs: long body\n\n${"x".repeat(7000)}`, {
			"notes.md": "notes\n",
		});
		const { agent, calls } = fakeAgent({ finder: () => ({ findings: [] }) });
		await review(repo.config, { cwd: repo.root, agent, effort: "quick" });
		const prompt = calls[0]?.prompt ?? "";
		expect(prompt).not.toContain("Merge branch side");
		expect(prompt).not.toContain("x".repeat(6001));
		expect(prompt).toContain("x".repeat(5000));
	});

	test("a review with only nits passes in one round", async () => {
		const repo = await branchRepo();
		const { agent, calls } = fakeAgent({
			finder: () => ({ findings: [candidate({ severity: "nit" })] }),
		});
		const outcome = await review(repo.config, {
			cwd: repo.root,
			agent,
			effort: "quick",
		});
		expect(outcome.passed).toBe(true);
		expect(outcome.found.map((finding) => finding.severity)).toEqual(["nit"]);
		expect(calls).toHaveLength(1);
	});

	test("an unchanged head is not reviewed twice", async () => {
		const repo = await branchRepo();
		const { agent } = fakeAgent({
			finder: () => ({ summary: "", findings: [], fixed: [] }),
		});
		await review(repo.config, { cwd: repo.root, agent });
		const again = await review(repo.config, { cwd: repo.root, agent });
		expect(again.skipped).toContain("already reviewed");
	});

	test("a reviewer that fails records an error round, so the gate fails open", async () => {
		const repo = await branchRepo();
		const agent: ReviewAgent = {
			name: "broken",
			ask: async () => {
				throw new ReviewerError("claude ran past 600s");
			},
		};
		const outcome = await review(repo.config, { cwd: repo.root, agent });
		expect(outcome.round?.error).toBe("claude ran past 600s");
		const saved = JSON.parse(readFileSync(outcome.file ?? "", "utf8"));
		expect(saved.rounds[0].error).toBe("claude ran past 600s");
	});

	test("uncommitted changes stop the review with what to do", async () => {
		const repo = await branchRepo();
		await repo.write("src/a.ts", "changed\n");
		const { agent } = fakeAgent({ finder: () => ({}) });
		await expect(
			review(repo.config, { cwd: repo.root, agent }),
		).rejects.toThrow(ReviewInputError);
		await expect(
			review(repo.config, { cwd: repo.root, agent }),
		).rejects.toThrow("Commit your changes first");
	});

	test("no commits beyond the base means nothing to review", async () => {
		const repo = await tempRepo();
		const config = resolveConfig({}, repo.root, "x");
		const { agent, calls } = fakeAgent({ finder: () => ({}) });
		const outcome = await review(config, { cwd: repo.root, agent });
		expect(outcome.skipped).toContain("nothing to review");
		expect(calls).toHaveLength(0);
	});

	test("a high-risk change is reviewed at deep effort with a majority vote", async () => {
		const repo = await tempRepo();
		await repo.git("checkout", "-q", "-b", "ci/workflow");
		await repo.commit("ci: add workflow", {
			".github/workflows/x.yml": "on: push\n",
		});
		const config = resolveConfig({ extends: ["recommended"] }, repo.root, "x");
		const { agent, calls } = fakeAgent({
			finder: () => ({
				summary: "",
				findings: [candidate({ file: ".github/workflows/x.yml", line: 1 })],
				fixed: [],
			}),
			verifier: (_, call) => ({
				candidates: [
					{ id: "C1", real: call < 2, severity: "important", reason: "" },
				],
				previous: [],
			}),
		});
		const outcome = await review(config, { cwd: repo.root, agent });
		expect(outcome.round?.effort).toBe("deep");
		expect(outcome.round?.tier).toBe("high");
		expect(calls).toHaveLength(6);
		expect(outcome.found).toHaveLength(1);
	});

	test("skip globs leave files out of the diff", async () => {
		const repo = await branchRepo();
		await repo.commit("chore: snapshots", {
			"src/__snapshots__/a.snap": "SNAPSHOT_TEXT\n",
		});
		const config = resolveConfig(
			{ review: { skip: ["**/*.snap"] } },
			repo.root,
			"x",
		);
		const { agent, calls } = fakeAgent({
			finder: () => ({ summary: "", findings: [], fixed: [] }),
		});
		await review(config, { cwd: repo.root, agent, effort: "quick" });
		expect(calls[0]?.prompt).not.toContain("SNAPSHOT_TEXT");
		expect(calls[0]?.prompt).toContain("**/*.snap");
	});
});

describe("verdicts on earlier findings", () => {
	/** A verifier that fails the test if it is asked about f1. */
	const noVerdictOnF1 = () =>
		fakeAgent({
			finder: () => ({ findings: [] }),
			verifier: (request) => {
				if (request.prompt.includes("f1 src/a.ts"))
					throw new Error("f1 was judged again on an unchanged file");
				return { candidates: [], previous: [] };
			},
		});

	/** Round 1 at standard effort reports f1 in src/a.ts. */
	async function reported() {
		const repo = await branchRepo();
		const { agent } = fakeAgent({
			finder: (_, call) => ({ findings: call === 0 ? [candidate()] : [] }),
			verifier: () => ({
				candidates: [
					{ id: "C1", real: true, severity: "important", reason: "yes" },
				],
			}),
		});
		const first = await review(repo.config, { cwd: repo.root, agent });
		expect(first.found.map((entry) => entry.id)).toEqual(["f1"]);
		const emptyCommit = () =>
			repo.git("commit", "-q", "--allow-empty", "-m", "fix: retry");
		return { repo, emptyCommit };
	}

	test("empty commits get no new verdict, and the finding stays open", async () => {
		const { repo, emptyCommit } = await reported();
		for (let attempt = 0; attempt < 3; attempt++) {
			await emptyCommit();
			const { agent, calls } = noVerdictOnF1();
			const outcome = await review(repo.config, { cwd: repo.root, agent });
			expect(calls).toEqual([]);
			expect(outcome.round?.scope).toBe("diff");
			expect(outcome.passed).toBe(false);
			expect(reviewReport(outcome, 2)).toContain(
				"f1 is still open: no commit since the last check changed any reviewed file, so the verifier does not judge it again. Fix it (src/a.ts), or answer it with `cagr review answer f1",
			);
			// The recheck at the same commit is no reroll either.
			const again = await review(repo.config, { cwd: repo.root, agent });
			expect(calls).toEqual([]);
			expect(again.skipped).toContain(
				"f1 is still open: no commit since the last check changed any reviewed file",
			);
		}
		// Neither is --full, which runs the finders but does not judge f1.
		await emptyCommit();
		const { agent, calls } = noVerdictOnF1();
		const forced = await review(repo.config, {
			cwd: repo.root,
			agent,
			full: true,
		});
		expect(calls.map((call) => call.schema)).toEqual([
			finderSchema,
			finderSchema,
		]);
		expect(forced.record.findings[0]?.status).toBe("open");
		expect(forced.record.findings[0]?.verdicts).toBeUndefined();
		expect(
			gateResult(forced.record, forced.round?.head ?? "", repo.config).kind,
		).toBe("deny");
	});

	test("a commit that changes another file, such as a new test, gets a verdict", async () => {
		const { repo, emptyCommit } = await reported();
		await emptyCommit();
		await review(repo.config, { cwd: repo.root, agent: noVerdictOnF1().agent });
		await repo.commit("test(auth): cover an expired session", {
			"src/a.test.ts": "test('expired session', () => {});\n",
		});
		const { agent, calls } = fakeAgent({
			finder: () => ({ findings: [] }),
			verifier: () => ({ previous: [{ id: "f1", fixed: true }] }),
		});
		const outcome = await review(repo.config, { cwd: repo.root, agent });
		const verifiers = calls.filter((call) => call.schema === verifierSchema);
		expect(verifiers).toHaveLength(1);
		expect(verifiers[0]?.prompt).toContain("f1 src/a.ts");
		expect(outcome.fixed.map((entry) => entry.id)).toEqual(["f1"]);
		expect(outcome.passed).toBe(true);
	});

	test("a finding gets at most three verdicts, then only an answer closes it", async () => {
		const { repo } = await reported();
		const stubborn = () =>
			fakeAgent({
				finder: () => ({ findings: [] }),
				verifier: () => ({ previous: [{ id: "f1", fixed: false }] }),
			});
		let edit = 0;
		const touch = () =>
			repo.commit(`fix: attempt ${++edit}`, { "src/a.ts": `// ${edit}\n` });
		await touch();
		await review(repo.config, { cwd: repo.root, agent: stubborn().agent });
		// The one recheck at a commit counts toward the cap too.
		const recheck = await review(repo.config, {
			cwd: repo.root,
			agent: stubborn().agent,
		});
		expect(recheck.round?.scope).toBe("verify");
		await touch();
		const third = await review(repo.config, {
			cwd: repo.root,
			agent: stubborn().agent,
		});
		expect(third.record.findings[0]?.verdicts).toBe(3);
		await touch();
		const lenient = fakeAgent({
			finder: () => ({ findings: [] }),
			verifier: () => ({ previous: [{ id: "f1", fixed: true }] }),
		});
		const capped = await review(repo.config, {
			cwd: repo.root,
			agent: lenient.agent,
		});
		expect(
			lenient.calls.some(
				(call) =>
					call.schema === verifierSchema && call.prompt.includes("f1 src/a.ts"),
			),
		).toBe(false);
		expect(capped.passed).toBe(false);
		expect(reviewReport(capped, 2)).toContain(
			"f1 is still open: the verifier judged it 3 times, the most it may. Answer it with `cagr review answer f1",
		);
		const again = await review(repo.config, {
			cwd: repo.root,
			agent: lenient.agent,
		});
		expect(again.skipped).toContain("judged it 3 times");
		expect(again.passed).toBe(false);
	});

	test("a reviewer error after a rebase does not hold the gate on a fix the rebase kept", async () => {
		const repo = await branchRepo();
		const { agent } = fakeAgent({
			finder: (_, call) => ({ findings: call === 0 ? [candidate()] : [] }),
			verifier: () => ({ previous: [{ id: "f1", fixed: true }] }),
		});
		const options = { cwd: repo.root, effort: "quick" as const };
		await review(repo.config, { ...options, agent });
		await repo.commit("fix: handle the session", {
			"src/a.ts": "user?.name\n",
		});
		expect((await review(repo.config, { ...options, agent })).passed).toBe(
			true,
		);
		await repo.git("commit", "-q", "--amend", "-m", "fix: handle a session");
		const broken: ReviewAgent = {
			name: "broken",
			ask: async () => {
				throw new ReviewerError("claude ran past 600s");
			},
		};
		const outcome = await review(repo.config, { ...options, agent: broken });
		expect(outcome.round?.scope).toBe("full");
		expect(outcome.round?.error).toBe("claude ran past 600s");
		expect(outcome.open).toEqual([]);
		expect(reviewReport(outcome, 2)).toContain("went out unreviewed");
		const head = outcome.round?.head ?? "";
		const gate = gateResult(
			outcome.record,
			head,
			repo.config,
			await reachFrom(outcome.record, head, repo.root),
		);
		expect(gate.kind).toBe("allow");
		expect(gate.kind === "allow" && gate.notice).toContain("unreviewed");
		// A rebase that drops the fix still holds the gate.
		await repo.commit("revert: drop the fix", { "src/a.ts": "user.name\n" });
		await repo.git("commit", "-q", "--amend", "-m", "fix: drop it");
		const dropped = await review(repo.config, { ...options, agent: broken });
		expect(dropped.open.map((entry) => entry.id)).toEqual(["f1"]);
		const droppedHead = dropped.round?.head ?? "";
		expect(
			gateResult(
				dropped.record,
				droppedHead,
				repo.config,
				await reachFrom(dropped.record, droppedHead, repo.root),
			).kind,
		).toBe("deny");
	});

	test("a reviewer error after a reset to before a fix in another file still holds the gate", async () => {
		const repo = await branchRepo();
		const { agent } = fakeAgent({
			finder: (_, call) => ({ findings: call === 0 ? [candidate()] : [] }),
			verifier: () => ({ previous: [{ id: "f1", fixed: true }] }),
		});
		const options = { cwd: repo.root, effort: "quick" as const };
		const first = await review(repo.config, { ...options, agent });
		await repo.commit("fix: check the session in the caller", {
			"src/b.ts": "if (!user) return;\n",
		});
		expect((await review(repo.config, { ...options, agent })).passed).toBe(
			true,
		);
		await repo.git("reset", "-q", "--hard", first.round?.head ?? "");
		await repo.commit("feat: more", { "src/c.ts": "c\n" });
		const broken: ReviewAgent = {
			name: "broken",
			ask: async () => {
				throw new ReviewerError("claude ran past 600s");
			},
		};
		const outcome = await review(repo.config, { ...options, agent: broken });
		expect(outcome.round?.error).toBe("claude ran past 600s");
		expect(outcome.open.map((entry) => entry.id)).toEqual(["f1"]);
		const head = outcome.round?.head ?? "";
		expect(
			gateResult(
				outcome.record,
				head,
				repo.config,
				await reachFrom(outcome.record, head, repo.root),
			).kind,
		).toBe("deny");
	});

	test("a finding the verifier reopens gets a fresh count of verdicts", async () => {
		const { repo } = await reported();
		const verdict = (fixed: boolean) =>
			fakeAgent({
				finder: () => ({ findings: [] }),
				verifier: () => ({ previous: [{ id: "f1", fixed }] }),
			});
		let edit = 0;
		const touch = () =>
			repo.commit(`fix: attempt ${++edit}`, { "src/a.ts": `// ${edit}\n` });
		await touch();
		await review(repo.config, { cwd: repo.root, agent: verdict(false).agent });
		await review(repo.config, { cwd: repo.root, agent: verdict(false).agent });
		await touch();
		const closed = await review(repo.config, {
			cwd: repo.root,
			agent: verdict(true).agent,
		});
		expect(closed.fixed.map((entry) => entry.id)).toEqual(["f1"]);
		expect(closed.record.findings[0]?.verdicts).toBe(3);
		// Past the round cap a later commit checks the fix again, and it no longer holds.
		await touch();
		const reopened = await review(repo.config, {
			cwd: repo.root,
			agent: verdict(false).agent,
		});
		expect(reopened.record.findings[0]?.status).toBe("open");
		await touch();
		const next = verdict(true);
		const outcome = await review(repo.config, {
			cwd: repo.root,
			agent: next.agent,
		});
		expect(
			next.calls.some(
				(call) =>
					call.schema === verifierSchema && call.prompt.includes("f1 src/a.ts"),
			),
		).toBe(true);
		expect(outcome.passed).toBe(true);
	});
});

describe("findings", () => {
	test("finders by effort", () => {
		expect(findersFor("quick", true)).toEqual(["bugs"]);
		expect(findersFor("standard", true)).toEqual(["bugs", "security"]);
		expect(findersFor("standard", false)).toEqual(["bugs", "behavior"]);
		expect(findersFor("deep", true)).toEqual(["bugs", "security", "behavior"]);
	});

	test("style findings are dropped and twins merge at the higher severity", () => {
		const merged = mergeCandidates(
			[
				candidate({ severity: "nit" }),
				candidate({ line: 11, title: "Null user crashes handler" }),
				candidate({ category: "style", file: "src/b.ts", title: "Rename x" }),
			],
			[],
		);
		expect(merged).toHaveLength(1);
		expect(merged[0]?.severity).toBe("important");
	});

	test("a finding already reported is not reported again, unless it was fixed and came back", () => {
		expect(mergeCandidates([candidate()], [finding()])).toEqual([]);
		expect(
			mergeCandidates([candidate()], [finding({ status: "answered" })]),
		).toEqual([]);
		expect(
			mergeCandidates([candidate()], [finding({ status: "fixed" })]),
		).toHaveLength(1);
	});

	test("findings with no line are kept apart unless their titles agree", () => {
		const general = (title: string, file = "") =>
			candidate({ file, line: 0, title });
		expect(
			mergeCandidates(
				[
					general("Secrets logged on startup"),
					general("Retry loop never ends"),
				],
				[],
			),
		).toHaveLength(2);
		expect(
			mergeCandidates(
				[general("Retry loop never ends", "src/a.ts")],
				[
					finding({
						line: 0,
						title: "Docs are out of date",
						status: "answered",
					}),
				],
			),
		).toHaveLength(1);
		expect(
			mergeCandidates(
				[general("Retry loop never ends"), general("Retry loop never stops")],
				[],
			),
		).toHaveLength(1);
	});

	test("the vote keeps a candidate only with a majority and takes the common severity", () => {
		const keyed = [{ ...candidate(), key: "C1" }];
		const vote = (real: boolean, severity: "important" | "nit") => ({
			candidates: [{ id: "C1", real, severity, reason: "" }],
			previous: [{ id: "f1", fixed: real, reason: "" }],
		});
		const kept = tally(
			keyed,
			[vote(true, "nit"), vote(true, "nit"), vote(false, "important")],
			[finding()],
		);
		expect(kept.kept[0]?.severity).toBe("nit");
		expect([...kept.fixed]).toEqual(["f1"]);
		expect(
			tally(
				keyed,
				[vote(true, "nit"), vote(false, "nit"), vote(false, "nit")],
				[finding()],
			).kept,
		).toEqual([]);
	});

	test("normalizeFinder keeps what it can from a loose answer", () => {
		const output = normalizeFinder({
			findings: [
				{ title: "x", severity: "huge", line: -3, file: "./src/a.ts" },
				{ nope: 1 },
			],
		});
		expect(output.findings).toEqual([
			{
				severity: "nit",
				category: "other",
				file: "src/a.ts",
				line: 0,
				title: "x",
				detail: "",
				bug_class: "",
			},
		]);
		expect(normalizeFinder(null).findings).toEqual([]);
	});
});
