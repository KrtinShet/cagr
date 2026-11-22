import { expect, test } from "bun:test";
import { join } from "node:path";
import { config } from "../test/config";
import { tempRepo } from "../test/repo";
import { finding, head, record, round } from "../test/review";
import type { Gh } from "./github";
import {
	postStatus,
	postStatusAfterPush,
	reviewStatus,
	sendReviewStatus,
} from "./status";
import { recordPath, writeRecord } from "./store";

const settings = config({ review: { enabled: true, status: true } });

/** A fake gh that records each call and answers from `reply`. */
function fakeGh(reply: (args: string[]) => string | Error = () => "") {
	const calls: string[][] = [];
	const gh: Gh = async (args) => {
		calls.push(args);
		const answer = reply(args);
		if (answer instanceof Error) throw answer;
		return answer;
	};
	return { gh, calls };
}

const field = (args: string[] | undefined, name: string) =>
	args?.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);

test("a passed review is success, open findings are failure with the count", () => {
	expect(reviewStatus(record([round()]), head, settings)).toEqual({
		context: "cagr/review",
		state: "success",
		description: "Passed: no Important finding is open.",
	});
	const failed = reviewStatus(
		record([round()], [finding(), finding({ id: "f2" })]),
		head,
		settings,
	);
	expect(failed.state).toBe("failure");
	expect(failed.description).toBe(
		"2 Important findings open. Fix or answer them, then run cagr review.",
	);
});

test("no review, or a review of an older commit, is pending", () => {
	expect(reviewStatus(null, head, settings).state).toBe("pending");
	const stale = reviewStatus(
		record([round()], [finding()]),
		"c".repeat(40),
		settings,
	);
	expect(stale).toMatchObject({
		state: "pending",
		description: "Not reviewed at this commit. Run cagr review.",
	});
});

test("a review that could not run is success that says so", () => {
	const status = reviewStatus(
		record([round({ error: "claude not found" })]),
		head,
		settings,
	);
	expect(status.state).toBe("success");
	expect(status.description).toContain("went out unreviewed");
	expect(status.description.length).toBeLessThanOrEqual(140);
});

test("postStatus calls the statuses API with the state and context", async () => {
	const { gh, calls } = fakeGh();
	const result = await postStatus(gh, head, {
		context: "cagr/review",
		state: "success",
		description: "Passed.",
	});
	expect(result).toEqual({
		ok: true,
		message: "Set cagr/review to success on aaaaaaa.",
	});
	expect(calls[0]?.slice(0, 4)).toEqual([
		"api",
		"-X",
		"POST",
		`repos/{owner}/{repo}/statuses/${head}`,
	]);
	expect(field(calls[0], "state")).toBe("success");
	expect(field(calls[0], "context")).toBe("cagr/review");
});

test("postStatus fails open with a note that names the fix", async () => {
	const note = async (message: string) =>
		(
			await postStatus(fakeGh(() => new Error(message)).gh, head, {
				context: "cagr/review",
				state: "success",
				description: "x",
			})
		).message;
	expect(await note("Could not start `gh api`: not found")).toContain(
		"gh is not installed",
	);
	expect(
		await note("gh api failed: To get started, run: gh auth login"),
	).toContain("Run `gh auth login`");
	expect(
		await note("gh api failed: No commit found for SHA (HTTP 422)"),
	).toContain("GitHub does not have aaaaaaa yet");
	expect(await note("gh api failed: HTTP 403")).toContain("gh auth status");
});

test("sendReviewStatus reads the branch record and posts on HEAD; off does nothing", async () => {
	const repo = await tempRepo();
	await repo.git("checkout", "-q", "-b", "feat/x");
	const sha = await repo.git("rev-parse", "HEAD");
	const commonDir = join(repo.root, ".git");
	writeRecord(
		recordPath(commonDir, "feat/x"),
		record([round({ head: sha })], [finding()]),
	);
	const { gh, calls } = fakeGh();
	const note = await sendReviewStatus(settings, repo.root, gh);
	expect(note).toBe(`Set cagr/review to failure on ${sha.slice(0, 7)}.`);
	expect(calls[0]?.[3]).toBe(`repos/{owner}/{repo}/statuses/${sha}`);
	const off = fakeGh();
	expect(
		await sendReviewStatus(
			config({ review: { enabled: true } }),
			repo.root,
			off.gh,
		),
	).toBeNull();
	expect(off.calls).toEqual([]);
});

test("after a push it waits for GitHub to have the commit, then sends both statuses", async () => {
	const repo = await tempRepo();
	const sha = await repo.git("rev-parse", "HEAD");
	writeRecord(
		recordPath(join(repo.root, ".git"), "feat/x"),
		record([round({ head: sha })]),
	);
	let lookups = 0;
	const { gh, calls } = fakeGh((args) => {
		if (args[1]?.includes("/commits/"))
			return ++lookups < 3 ? new Error("gh api failed: HTTP 422") : "";
		return "";
	});
	const sleeps: number[] = [];
	const lines = await postStatusAfterPush(
		settings,
		repo.root,
		{ sha, branch: "feat/x", checks: ["bun run verify"], waitSeconds: 60 },
		gh,
		async (ms) => {
			sleeps.push(ms);
		},
	);
	expect(sleeps).toEqual([3000, 3000]);
	const posts = calls.filter((args) => args[2] === "POST");
	expect(
		posts.map((args) => [field(args, "context"), field(args, "state")]),
	).toEqual([
		["cagr/checks", "success"],
		["cagr/review", "success"],
	]);
	expect(field(posts[0], "description")).toBe(
		"The pre-push commands passed: bun run verify",
	);
	expect(lines).toHaveLength(2);
});

test("post-status requires evidence for the pushed SHA, including after the cap", async () => {
	const repo = await tempRepo();
	const first = await repo.git("rev-parse", "HEAD");
	const second = await repo.commit("fix: first review finding", {
		"src/a.ts": "first fix\n",
	});
	const third = await repo.commit("fix: second review finding", {
		"src/a.ts": "second fix\n",
	});
	const file = recordPath(join(repo.root, ".git"), "feat/x");
	const saved = record(
		[
			round({ head: first }),
			round({ n: 2, head: second, from: first, scope: "diff" }),
		],
		[finding()],
	);
	const state = async (sha: string) => {
		const { gh, calls } = fakeGh();
		writeRecord(file, saved);
		await postStatusAfterPush(
			settings,
			repo.root,
			{ sha, branch: "feat/x", checks: null, waitSeconds: 0 },
			gh,
		);
		return field(
			calls.find((args) => args[2] === "POST"),
			"state",
		);
	};
	expect(await state(third)).toBe("pending");
	expect(await state(second)).toBe("pending");
	saved.rounds.push(
		round({ n: 3, head: third, from: second, scope: "verify" }),
	);
	expect(await state(third)).toBe("pending");
	const issue = saved.findings[0];
	if (!issue) throw new Error("Missing fixture finding");
	issue.status = "fixed";
	issue.fixedIn = third;
	expect(await state(third)).toBe("success");
	const extra = await repo.commit("feat: unrelated", {
		"src/b.ts": "unreviewed\n",
	});
	expect(await state(extra)).toBe("pending");
	saved.rounds.push(
		round({ n: 4, head: extra, scope: "verify", error: "timeout" }),
	);
	expect(await state(extra)).toBe("pending");
});

test("after a push, gh that is not logged in stops the wait and the note says so", async () => {
	const repo = await tempRepo();
	const sha = await repo.git("rev-parse", "HEAD");
	const { gh } = fakeGh(() => new Error("gh api failed: run gh auth login"));
	const sleeps: number[] = [];
	const lines = await postStatusAfterPush(
		settings,
		repo.root,
		{ sha, branch: "feat/x", checks: null, waitSeconds: 60 },
		gh,
		async (ms) => {
			sleeps.push(ms);
		},
	);
	expect(sleeps).toEqual([]);
	expect(lines).toEqual([expect.stringContaining("gh is not logged in")]);
});
