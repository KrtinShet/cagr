import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveConfig } from "../config/load";
import { repoTestTimeout } from "../test/budgets";
import { tempRepo } from "../test/repo";
import { finding, record, round } from "../test/review";
import type { ReviewAgent } from "./agent";
import {
	ciReview,
	decodeState,
	encodeState,
	type Gh,
	pullRequestFromEvent,
} from "./github";
import { finderSchema } from "./prompt";

test("review state survives a round trip through a comment", () => {
	const saved = record([round()], [finding()]);
	expect(decodeState(`text\n${encodeState(saved)}\nmore`)).toEqual(saved);
	expect(decodeState("no marker")).toBeNull();
	expect(decodeState("<!-- cagr-review bm90IGpzb24= -->")).toBeNull();
});

test("the pull request comes from the GitHub event", async () => {
	const repo = await tempRepo();
	const path = join(repo.root, "event.json");
	writeFileSync(
		path,
		JSON.stringify({
			pull_request: {
				number: 7,
				body: null,
				base: { ref: "main" },
				head: { sha: "abc" },
			},
		}),
	);
	expect(
		pullRequestFromEvent({ GITHUB_EVENT_PATH: path, GITHUB_REPOSITORY: "o/r" }),
	).toEqual({ number: 7, repo: "o/r", base: "main", head: "abc", body: "" });
	expect(() => pullRequestFromEvent({})).toThrow("runs in GitHub Actions");
});

/** A fake gh: issue comments and review threads are canned, posts are recorded. */
function fakeGh(options: {
	comments?: { id: number; body: string; login?: string }[];
	resolved?: string[];
	threadAuthor?: string;
	rejectInline?: boolean;
	rejectAll?: boolean;
	rejectState?: boolean;
}) {
	const posts: { args: string[]; body: Record<string, unknown> }[] = [];
	const gh: Gh = async (args, stdin) => {
		if (args.includes("graphql"))
			return JSON.stringify({
				data: {
					repository: {
						pullRequest: {
							reviewThreads: {
								nodes: (options.resolved ?? []).map((id) => ({
									isResolved: true,
									resolvedBy: { login: "ana" },
									comments: {
										nodes: [
											{
												body: `x <!-- cagr:${id} -->`,
												author: {
													login: options.threadAuthor ?? "github-actions",
												},
											},
										],
									},
								})),
							},
						},
					},
				},
			});
		if (!args.includes("-X"))
			return (options.comments ?? [])
				.map((comment) =>
					JSON.stringify({ login: "github-actions[bot]", ...comment }),
				)
				.join("\n");
		const body = JSON.parse(stdin ?? "{}") as Record<string, unknown>;
		if (options.rejectAll && args.some((arg) => arg.endsWith("/reviews")))
			throw new Error(
				"gh api failed: commit_id is not part of the pull request",
			);
		if (
			options.rejectInline &&
			Array.isArray(body.comments) &&
			body.comments.length > 0
		)
			throw new Error("gh api failed: line must be part of the diff");
		if (options.rejectState && args.some((arg) => arg.includes("/issues/")))
			throw new Error(
				"gh api -X POST failed: Resource not accessible by integration (HTTP 403)",
			);
		posts.push({ args, body });
		return "{}";
	};
	return { gh, posts };
}

async function prRepo(headSha?: string) {
	const repo = await tempRepo();
	await repo.git("checkout", "-q", "-b", "feat/x");
	const head = await repo.commit("feat: add a", {
		"src/a.ts": "export const a = 1;\n",
	});
	const path = join(repo.root, "..", `event-${Date.now()}.json`);
	writeFileSync(
		path,
		JSON.stringify({
			pull_request: {
				number: 3,
				body: "",
				base: { ref: "main" },
				head: { sha: headSha ?? head },
			},
		}),
	);
	const config = resolveConfig({ review: { enabled: true } }, repo.root, "x");
	const env = { GITHUB_EVENT_PATH: path, GITHUB_REPOSITORY: "o/r" };
	return { repo, config, env, head };
}

const oneBug: ReviewAgent = {
	name: "fake",
	async ask(request) {
		if (request.schema === finderSchema)
			return {
				summary: "1 important.",
				findings: [
					{
						severity: "important",
						category: "bug",
						file: "src/a.ts",
						line: 1,
						title: "a is wrong",
						detail: "",
						bug_class: "",
					},
				],
				fixed: [],
			};
		return {
			candidates: [{ id: "C1", real: true, severity: "important", reason: "" }],
			previous: [],
		};
	},
};

test("a CI round posts inline comments, saves state, and fails on an open finding", async () => {
	const { repo, config, env, head } = await prRepo();
	const { gh, posts } = fakeGh({});
	const result = await ciReview(config, repo.root, { gh, env, agent: oneBug });
	expect(result.ok).toBe(false);
	const reviewPost = posts.find((post) =>
		post.args.some((arg) => arg.endsWith("/pulls/3/reviews")),
	);
	expect(reviewPost?.body.event).toBe("COMMENT");
	expect(reviewPost?.body.commit_id).toBe(head);
	const comments = reviewPost?.body.comments as {
		path: string;
		body: string;
	}[];
	expect(comments[0]?.path).toBe("src/a.ts");
	expect(comments[0]?.body).toContain("<!-- cagr:f1 -->");
	const statePost = posts.find((post) =>
		post.args.includes("repos/o/r/issues/3/comments"),
	);
	const state = decodeState(String(statePost?.body.body));
	expect(state?.findings[0]?.status).toBe("open");
});

test("a resolved thread answers the finding, and an unchanged head is not reviewed again", async () => {
	const { repo, config, env } = await prRepo();
	const first = fakeGh({});
	await ciReview(config, repo.root, { gh: first.gh, env, agent: oneBug });
	const stateBody = String(
		first.posts.find((post) =>
			post.args.includes("repos/o/r/issues/3/comments"),
		)?.body.body,
	);
	const second = fakeGh({
		comments: [{ id: 99, body: stateBody }],
		resolved: ["f1"],
	});
	const result = await ciReview(config, repo.root, {
		gh: second.gh,
		env,
		agent: oneBug,
	});
	expect(result.ok).toBe(true);
	expect(
		second.posts.some((post) =>
			post.args.some((arg) => arg.endsWith("/reviews")),
		),
	).toBe(false);
	const patch = second.posts.find((post) => post.args.includes("PATCH"));
	expect(patch?.args).toContain("repos/o/r/issues/comments/99");
	expect(
		decodeState(String(patch?.body.body))?.findings[0]?.answer?.reason,
	).toContain("resolved on GitHub by ana");
});

test("when GitHub rejects an inline comment the findings go in the review body", async () => {
	const { repo, config, env } = await prRepo();
	const { gh, posts } = fakeGh({ rejectInline: true });
	await ciReview(config, repo.root, { gh, env, agent: oneBug });
	const reviewPost = posts.find((post) =>
		post.args.some((arg) => arg.endsWith("/reviews")),
	);
	expect(reviewPost?.body.comments).toBeUndefined();
	expect(String(reviewPost?.body.body)).toContain("<!-- cagr:f1 -->");
});

test("a reviewer that cannot run does not fail the check", async () => {
	const { repo, config, env } = await prRepo();
	const { gh } = fakeGh({});
	const broken: ReviewAgent = {
		name: "broken",
		ask: async () => {
			const { ReviewerError } = await import("./agent");
			throw new ReviewerError("no API key");
		},
	};
	const result = await ciReview(config, repo.root, { gh, env, agent: broken });
	expect(result.ok).toBe(true);
	expect(result.report).toContain("The reviewer could not run: no API key");
});

const brokenAgent: ReviewAgent = {
	name: "broken",
	ask: async () => {
		const { ReviewerError } = await import("./agent");
		throw new ReviewerError("no API key");
	},
};

test("CI at the cap reports unreviewed commits and passes when the last Important finding is answered", async () => {
	const { repo, config, head } = await prRepo();
	const later = await repo.commit("feat: more", { "src/b.ts": "more\n" });
	const state = encodeState(
		record(
			[
				round({ head }),
				round({ n: 2, head, scope: "diff" }),
				round({ n: 3, head, scope: "verify" }),
			],
			[finding()],
		),
	);
	const pr = { number: 3, repo: "o/r", base: "main", head: later, body: "" };
	const agent: ReviewAgent = {
		name: "unexpected",
		ask: async () => {
			throw new Error("CI must not run reviewers past the cap");
		},
	};
	for (const resolved of [[], ["f1"]]) {
		const { gh, posts } = fakeGh({
			comments: [{ id: 99, body: state, login: "owner" }],
			threadAuthor: "owner",
			resolved,
		});
		const result = await ciReview(config, repo.root, {
			gh,
			local: { pr, login: "owner" },
			agent,
		});
		expect(result.ok).toBe(resolved.length > 0);
		expect(result.report).toContain(
			"Reviewed through round 3; 1 later commit was not reviewed.",
		);
		expect(
			posts.some((post) => post.args.some((arg) => arg.endsWith("/reviews"))),
		).toBe(false);
	}
});

async function firstRoundState() {
	const setup = await prRepo();
	const first = fakeGh({});
	await ciReview(setup.config, setup.repo.root, {
		gh: first.gh,
		env: setup.env,
		agent: oneBug,
	});
	const state = String(
		first.posts.find((post) =>
			post.args.includes("repos/o/r/issues/3/comments"),
		)?.body.body,
	);
	return { ...setup, state };
}

test(
	"a reviewer that cannot run still fails the check while earlier findings are open",
	async () => {
		const { repo, config, env, state } = await firstRoundState();
		await repo.commit("feat: more", { "src/b.ts": "export const b = 1;\n" });
		const head = (await repo.git("rev-parse", "HEAD")).trim();
		const event = JSON.parse(await Bun.file(env.GITHUB_EVENT_PATH).text()) as {
			pull_request: { head: { sha: string } };
		};
		event.pull_request.head.sha = head;
		writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(event));
		const { gh } = fakeGh({ comments: [{ id: 99, body: state }] });
		const result = await ciReview(config, repo.root, {
			gh,
			env,
			agent: brokenAgent,
		});
		expect(result.ok).toBe(false);
	},
	repoTestTimeout,
);

test(
	"a reviewer that cannot run still fails the check on a fix the head does not contain",
	async () => {
		const { repo, config, env, head } = await prRepo();
		const fix = await repo.commit("fix: a", {
			"src/a.ts": "export const a = 2;\n",
		});
		await repo.git("reset", "-q", "--hard", head);
		const state = encodeState(
			record(
				[
					round({ head }),
					round({ n: 2, head: fix, from: head, scope: "diff" }),
				],
				[finding({ status: "fixed", fixedIn: fix })],
			),
		);
		const { gh } = fakeGh({ comments: [{ id: 99, body: state }] });
		const result = await ciReview(config, repo.root, {
			gh,
			env,
			agent: brokenAgent,
		});
		expect(result.ok).toBe(false);
		expect(result.report).toContain("Earlier Important findings still hold");
	},
	repoTestTimeout,
);

test("a state comment not written by the workflow is ignored", async () => {
	const { repo, config, env, head } = await prRepo();
	const forged = encodeState(record([round({ head })], [], "pr-3"));
	const { gh, posts } = fakeGh({
		comments: [{ id: 5, body: forged, login: "mallory" }],
	});
	const result = await ciReview(config, repo.root, { gh, env, agent: oneBug });
	expect(result.ok).toBe(false);
	expect(posts.some((post) => post.args.includes("PATCH"))).toBe(false);
});

test(
	"a resolved thread counts only when the workflow started it",
	async () => {
		const { repo, config, env, state } = await firstRoundState();
		const { gh } = fakeGh({
			comments: [{ id: 99, body: state }],
			resolved: ["f1"],
			threadAuthor: "mallory",
		});
		const result = await ciReview(config, repo.root, {
			gh,
			env,
			agent: oneBug,
		});
		expect(result.ok).toBe(false);
	},
	repoTestTimeout,
);

test("a checkout that is not the pull request's head is refused", async () => {
	const { repo, config, env } = await prRepo("f".repeat(40));
	const { gh } = fakeGh({});
	await expect(
		ciReview(config, repo.root, { gh, env, agent: oneBug }),
	).rejects.toThrow("not the pull request's head");
});

test("a review GitHub will not take is reported, and the state is still saved", async () => {
	const { repo, config, env } = await prRepo();
	const { gh, posts } = fakeGh({ rejectAll: true });
	const result = await ciReview(config, repo.root, { gh, env, agent: oneBug });
	expect(result.ok).toBe(false);
	expect(result.report).toContain("could not be posted");
	expect(
		posts.some((post) => post.args.includes("repos/o/r/issues/3/comments")),
	).toBe(true);
});

test("a state comment GitHub will not take is reported, not thrown, and names fork pull requests", async () => {
	const { repo, config, env } = await prRepo();
	const { gh } = fakeGh({ rejectState: true });
	const result = await ciReview(config, repo.root, {
		gh,
		env,
		agent: brokenAgent,
	});
	expect(result.ok).toBe(true);
	expect(result.report).toContain("The review state could not be saved");
	expect(result.report).toContain("pull requests from forks");
});

test("local review trusts the signed-in account's state and resolutions", async () => {
	const { repo, config, head } = await prRepo();
	const pr = { number: 3, repo: "o/r", base: "main", head, body: "" };
	const local = { pr, login: "OWNER" };
	const first = fakeGh({});
	await ciReview(config, repo.root, { gh: first.gh, local, agent: oneBug });
	const state = String(
		first.posts.find((post) =>
			post.args.includes("repos/o/r/issues/3/comments"),
		)?.body.body,
	);
	const { gh, posts } = fakeGh({
		comments: [{ id: 22, login: "owner", body: state }],
		threadAuthor: "owner",
		resolved: ["f1"],
	});
	const result = await ciReview(config, repo.root, {
		gh,
		local,
		agent: brokenAgent,
	});
	expect(result.ok).toBe(true);
	expect(result.complete).toBe(true);
	expect(
		posts.some(
			(post) =>
				post.args.includes("PATCH") &&
				post.args.includes("repos/o/r/issues/comments/22"),
		),
	).toBe(true);
});
