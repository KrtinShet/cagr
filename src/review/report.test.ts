import { expect, test } from "bun:test";
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

test("stats count rounds to pass, answers by kind, and reviewer errors", () => {
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
	const stats = reviewStats(records);
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
	expect(statsReport(reviewStats([]))).toBe("No reviews yet.");
});
