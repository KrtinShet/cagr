import { expect, test } from "bun:test";
import { config } from "../test/config";
import { finding, head, record, round } from "../test/review";
import { gateResult } from "./gate";

const settings = config({ review: { enabled: true } });

test("no review denies and says to run one", () => {
	const result = gateResult(null, head, settings);
	expect(result.kind).toBe("deny");
	expect(result.kind === "deny" && result.reason).toContain(
		"Run `cagr review`",
	);
});

test("a commit after the review denies until the new commits are reviewed", () => {
	const result = gateResult(record([round()]), "c".repeat(40), settings);
	expect(result.kind === "deny" && result.reason).toContain(
		"You committed after the last review",
	);
});

test("open Important findings deny and name each one with how to answer it", () => {
	const result = gateResult(record([round()], [finding()]), head, settings);
	expect(result.kind).toBe("deny");
	const reason = result.kind === "deny" ? result.reason : "";
	expect(reason).toContain("f1 src/a.ts:4  Crash on empty list");
	expect(reason).toContain("cagr review answer f1 --wrong");
	expect(reason).not.toContain("Step back");
});

test("nits, answered and fixed findings do not hold the gate", () => {
	const findings = [
		finding({ severity: "nit" }),
		finding({ id: "f2", status: "answered" }),
		finding({ id: "f3", status: "fixed" }),
	];
	expect(gateResult(record([round()], findings), head, settings)).toEqual({
		kind: "allow",
	});
});

test("after max_rounds the denial tells the author to step back", () => {
	const rounds = [round({ n: 1 }), round({ n: 2 }), round({ n: 3 })];
	const result = gateResult(record(rounds, [finding()]), head, settings);
	expect(result.kind === "deny" && result.reason).toContain("Step back");
});

test("a review that could not run lets the PR through and tells the human", () => {
	const result = gateResult(
		record([round({ error: "claude not found" })]),
		head,
		settings,
	);
	expect(result.kind).toBe("allow");
	expect(result.kind === "allow" && result.notice).toContain(
		"goes out unreviewed",
	);
});

test("a review that could not run does not open the gate on findings still open", () => {
	const rounds = [
		round({ n: 1, head: "c".repeat(40) }),
		round({ n: 2, error: "claude timed out" }),
	];
	const result = gateResult(record(rounds, [finding()]), head, settings);
	expect(result.kind).toBe("deny");
	const reason = result.kind === "deny" ? result.reason : "";
	expect(reason).toContain("could not run (claude timed out)");
	expect(reason).toContain("f1 src/a.ts:4");
	expect(reason).toContain("cagr review answer f1");
});

test("after an earlier good round, a failed one says the newest commits go out unreviewed", () => {
	const rounds = [
		round({ n: 1, head: "c".repeat(40) }),
		round({ n: 2, error: "x" }),
	];
	const result = gateResult(record(rounds), head, settings);
	expect(result.kind === "allow" && result.notice).toContain(
		"its newest commits go out unreviewed",
	);
});

test("the step-back message counts only rounds that ran", () => {
	const rounds = [
		round({ n: 1 }),
		round({ n: 2, error: "x" }),
		round({ n: 3 }),
		round({ n: 4 }),
	];
	const result = gateResult(record(rounds, [finding()]), head, settings);
	expect(result.kind === "deny" && result.reason).toContain(
		"has had 3 review rounds",
	);
});
