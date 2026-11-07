import { expect, test } from "bun:test";
import { maxFailedStops, needsCheck, stopDecision } from "./stop-decision";

const edited = { files: ["/repo/a.ts"], failedStops: 0 };
const lintOk = { name: "Lint", ok: true, output: "" };
const typesFail = {
	name: "Types",
	ok: false,
	output: "a.ts(1,7): error TS2322",
};

test("only checks turns that changed code in this checkout", () => {
	expect(needsCheck({ files: [], failedStops: 0 }, "/repo")).toBe(false);
	expect(needsCheck(edited, "/repo")).toBe(true);
	expect(needsCheck(edited, "/re")).toBe(false);
});

test("lets the agent stop when every check passes", () => {
	expect(stopDecision(edited, [lintOk, { ...typesFail, ok: true }])).toEqual({
		action: "allow",
	});
});

test("sends the agent back with the failing output", () => {
	const decision = stopDecision(edited, [lintOk, typesFail]);
	expect(decision.action).toBe("block");
	if (decision.action !== "block") return;
	expect(decision.reason).toContain("Types failed");
	expect(decision.reason).toContain("error TS2322");
	expect(decision.reason).not.toContain("## Lint");
});

test("cuts long output", () => {
	const decision = stopDecision(edited, [
		{ ...typesFail, output: "x".repeat(10_000) },
	]);
	expect(decision.action === "block" && decision.reason.length).toBeLessThan(
		3500,
	);
});

test("gives up instead of looping forever", () => {
	const decision = stopDecision(
		{ ...edited, failedStops: maxFailedStops - 1 },
		[typesFail],
	);
	expect(decision.action).toBe("give-up");
});
