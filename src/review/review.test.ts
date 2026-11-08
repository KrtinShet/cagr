import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveConfig } from "../config/load";
import { tempRepo } from "../test/repo";
import { type AgentRequest, type ReviewAgent, ReviewerError } from "./agent";
import { finderSchema } from "./prompt";
import { reviewReport } from "./report";
import {
	findersFor,
	mergeCandidates,
	normalizeFinder,
	ReviewInputError,
	review,
	tally,
} from "./review";
import type { Candidate, ReviewFinding } from "./types";

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
	await repo.commit("feat(auth): add login", {
		"src/a.ts": "export const login = (user) => user.name;\n",
	});
	const config = resolveConfig(
		{ review: { enabled: true } },
		repo.root,
		join(repo.root, "guardwright.toml"),
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
		expect(outcome.found.map((entry) => entry.title)).toEqual([
			"Null user crashes the handler",
		]);
		expect(outcome.found[0]?.id).toBe("f1");
		expect(outcome.passed).toBe(false);
		expect(outcome.file && existsSync(outcome.file)).toBe(true);
		expect(outcome.file).toContain(join(".git", "guardwright", "reviews"));
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
		await repo.commit("fix(auth): handle a missing user", {
			"src/a.ts": "export const login = (user) => user?.name;\n",
		});
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
