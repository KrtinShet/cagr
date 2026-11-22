import { expect, test } from "bun:test";
import { config } from "../test/config";
import { finding, head, record, round } from "../test/review";
import { gateResult } from "./gate";

const settings = config({ review: { enabled: true } });

test("no review denies and says to run one", () => {
	const result = gateResult(null, head, settings);
	expect(result.kind).toBe("deny");
	expect(result.kind === "deny" && result.reason).toContain(
		"Commit, run `cagr review`",
	);
});

test("a commit after the review denies until the new commits are reviewed", () => {
	const result = gateResult(record([round()]), "c".repeat(40), settings);
	expect(result.kind === "deny" && result.reason).toContain(
		"This commit differs from the last review",
	);
});

test("open Important findings deny and name each one with how to answer it", () => {
	const result = gateResult(record([round()], [finding()]), head, settings);
	expect(result.kind).toBe("deny");
	const reason = result.kind === "deny" ? result.reason : "";
	expect(reason).toContain("f1 src/a.ts:4  Crash on empty list");
	expect(reason).toContain("cagr review answer f1 --wrong");
	expect(reason).not.toContain("round cap");
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

test("after max_rounds the denial says no further full round runs", () => {
	const rounds = [round({ n: 1 }), round({ n: 2, scope: "diff" })];
	const result = gateResult(record(rounds, [finding()]), head, settings);
	expect(result.kind === "deny" && result.reason).toContain(
		"no further full round runs",
	);
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

test("an older head is judged by the current finding states, so a reopened finding fails it", () => {
	const older = "c".repeat(40);
	const rounds = [
		round({ n: 1, head: "d".repeat(40) }),
		round({ n: 2, head: older, scope: "diff" }),
		round({ n: 3, head, scope: "verify" }),
	];
	const fixed = finding({ status: "fixed", fixedIn: older });
	expect(gateResult(record(rounds, [fixed]), older, settings).kind).toBe(
		"allow",
	);
	const reopened = finding();
	const result = gateResult(record(rounds, [reopened]), older, settings);
	expect(result.kind).toBe("deny");
	expect(result.kind === "deny" && result.reason).toContain("f1 src/a.ts:4");
	const later = finding({ id: "f2", round: 3 });
	expect(gateResult(record(rounds, [later]), older, settings).kind).toBe(
		"allow",
	);
});

test("a fix judged on a later commit does not pass an older head", () => {
	const older = "c".repeat(40);
	const rounds = [
		round({ n: 1, head: older }),
		round({ n: 2, head, from: older, scope: "diff" }),
	];
	const later = finding({ status: "fixed", fixedIn: head });
	expect(gateResult(record(rounds, [later]), head, settings).kind).toBe(
		"allow",
	);
	const result = gateResult(record(rounds, [later]), older, settings);
	expect(result.kind === "deny" && result.reason).toContain("f1 src/a.ts:4");
	// An older record with no fix commit: fixed only at the last reviewed head.
	const unknown = finding({ status: "fixed", fixedIn: null });
	expect(gateResult(record(rounds, [unknown]), head, settings).kind).toBe(
		"allow",
	);
	expect(gateResult(record(rounds, [unknown]), older, settings).kind).toBe(
		"deny",
	);
	const answered = finding({ status: "answered" });
	expect(gateResult(record(rounds, [answered]), older, settings).kind).toBe(
		"allow",
	);
});

test("a full round starts a new cycle, so the cap counts from there", () => {
	const rounds = [
		round({ n: 1 }),
		round({ n: 2, scope: "diff" }),
		round({ n: 3, scope: "full" }),
	];
	const result = gateResult(record(rounds, [finding()]), head, settings);
	expect(result.kind === "deny" && result.reason).not.toContain("round cap");
});

test("failed rounds and verifier-only checks do not count toward the cap", () => {
	const rounds = [
		round({ n: 1 }),
		round({ n: 2, error: "x" }),
		round({ n: 2, scope: "verify" }),
	];
	const result = gateResult(record(rounds, [finding()]), head, settings);
	expect(result.kind === "deny" && result.reason).not.toContain("round cap");
});
