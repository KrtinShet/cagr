import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveConfig } from "../config/load";
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
	expect(decodeState("<!-- guardwright-review bm90IGpzb24= -->")).toBeNull();
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
	comments?: { id: number; body: string }[];
	resolved?: string[];
	rejectInline?: boolean;
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
										nodes: [{ body: `x <!-- guardwright:${id} -->` }],
									},
								})),
							},
						},
					},
				},
			});
		if (!args.includes("-X"))
			return (options.comments ?? [])
				.map((comment) => JSON.stringify(comment))
				.join("\n");
		const body = JSON.parse(stdin ?? "{}") as Record<string, unknown>;
		if (
			options.rejectInline &&
			Array.isArray(body.comments) &&
			body.comments.length > 0
		)
			throw new Error("gh api failed: line must be part of the diff");
		posts.push({ args, body });
		return "{}";
	};
	return { gh, posts };
}

async function prRepo() {
	const repo = await tempRepo();
	await repo.git("checkout", "-q", "-b", "feat/x");
	await repo.commit("feat: add a", { "src/a.ts": "export const a = 1;\n" });
	const path = join(repo.root, "..", `event-${Date.now()}.json`);
	writeFileSync(
		path,
		JSON.stringify({
			pull_request: {
				number: 3,
				body: "",
				base: { ref: "main" },
				head: { sha: "x" },
			},
		}),
	);
	const config = resolveConfig({ review: { enabled: true } }, repo.root, "x");
	const env = { GITHUB_EVENT_PATH: path, GITHUB_REPOSITORY: "o/r" };
	return { repo, config, env };
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
	const { repo, config, env } = await prRepo();
	const { gh, posts } = fakeGh({});
	const result = await ciReview(config, repo.root, { gh, env, agent: oneBug });
	expect(result.ok).toBe(false);
	const reviewPost = posts.find((post) =>
		post.args.some((arg) => arg.endsWith("/pulls/3/reviews")),
	);
	expect(reviewPost?.body.event).toBe("COMMENT");
	const comments = reviewPost?.body.comments as {
		path: string;
		body: string;
	}[];
	expect(comments[0]?.path).toBe("src/a.ts");
	expect(comments[0]?.body).toContain("<!-- guardwright:f1 -->");
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
	expect(String(reviewPost?.body.body)).toContain("<!-- guardwright:f1 -->");
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
