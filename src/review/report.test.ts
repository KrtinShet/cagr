import { expect, test } from "bun:test";
import { tempRepo } from "../test/repo";
import { finding, head, record, round } from "../test/review";
import {
	AnswerError,
	answerFinding,
	reviewStats,
	statsReport,
	statusReport,
} from "./report";

test("an answer needs a reason a person can check and a finding that exists", () => {
	const saved = record([round()], [finding()]);
	expect(() => answerFinding(saved, "f1", "wrong", "no")).toThrow(AnswerError);
	expect(() =>
		answerFinding(saved, "f9", "wrong", "the list is never empty here"),
	).toThrow('No finding "f9"');
	const answered = answerFinding(
		saved,
		"f1",
		"intentional",
		"  the list is never empty here  ",
	);
	expect(answered.status).toBe("answered");
	expect(answered.answer).toEqual({
		kind: "intentional",
		reason: "the list is never empty here",
	});
});

test("status says whether the last review covers the current commit", () => {
	expect(statusReport(null, head)).toContain("Not reviewed yet");
	const saved = record(
		[round()],
		[
			finding(),
			finding({
				id: "f2",
				status: "answered",
				answer: { kind: "minor", reason: "only in tests" },
			}),
		],
	);
	const current = statusReport(saved, head);
	expect(current).toContain("(the current commit)");
	expect(current).toContain("Open:\n- [important] f1");
	expect(current).toContain("(minor: only in tests)");
	expect(statusReport(saved, "c".repeat(40))).toContain(
		"before your latest commit",
	);
});

test("stats count rounds to pass, answers by kind, and reviewer errors", async () => {
	const records = [
		record([round()], [finding({ status: "fixed" })], "a"),
		record([round(), round({ n: 2 })], [], "b"),
		record(
			[round()],
			[
				finding({
					status: "answered",
					answer: { kind: "wrong", reason: "x" },
				}),
				finding({ id: "f2" }),
			],
			"c",
		),
		record([round({ error: "boom" })], [], "d"),
	];
	const stats = await reviewStats(records, ".");
	expect(stats.branches).toBe(3);
	expect(stats.passed).toBe(2);
	expect(stats.meanRounds).toBe(1.5);
	expect(stats.passedFirstRound).toBe(0.5);
	expect(stats.answers.wrong).toBe(1);
	expect(stats.errors).toBe(1);
	const text = statsReport(stats);
	expect(text).toContain("3 branches reviewed, 2 passing.");
	expect(text).toContain("Noise: 33% of findings were answered as wrong.");
	expect(text).toContain("failed to run 1 time.");
	expect(statsReport(await reviewStats([], "."))).toBe("No reviews yet.");
});

test("stats count later findings on added or replaced lines since round one", async () => {
	const repo = await tempRepo();
	const first = await repo.commit("feat: original", {
		"src/a.ts": "unchanged one\noriginal\nunchanged two\n",
	});
	const second = await repo.commit("fix: revise original", {
		"src/a.ts": "unchanged one\nreplaced\nnew\nunchanged two\n",
	});
	const saved = record(
		[
			round({ head: first }),
			round({ n: 2, head: second, from: first, scope: "diff" }),
		],
		[1, 2, 3, 4, 0].map((line) =>
			finding({ id: `f${line + 1}`, round: 2, line }),
		),
	);
	const stats = await reviewStats([saved], repo.root);
	expect(stats.fixLineShare).toBe(0.5);
	expect(statsReport(stats)).toContain(
		"Later-round findings on fix lines: 50%.",
	);
});

test("stats compare a later round with the full round that started its cycle", async () => {
	const repo = await tempRepo();
	const first = await repo.commit("feat: original", {
		"src/a.ts": "one\ntwo\nthree\n",
	});
	const rebased = await repo.commit("feat: rebased", {
		"src/a.ts": "one\nTWO\nthree\n",
	});
	const third = await repo.commit("fix: last line", {
		"src/a.ts": "one\nTWO\nTHREE\n",
	});
	const saved = record(
		[
			round({ head: first }),
			round({ n: 2, head: rebased, scope: "full" }),
			round({ n: 3, head: third, from: rebased, scope: "diff" }),
		],
		[finding({ round: 3, line: 2 })],
	);
	expect((await reviewStats([saved], repo.root)).fixLineShare).toBe(0);
});
