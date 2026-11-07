import { expect, test } from "bun:test";
import { readTimings, recordTimings } from "./timings";

test("timings are kept per repo", () => {
	const a = `/repo-a-${Date.now()}`;
	const b = `/repo-b-${Date.now()}`;
	recordTimings(a, [{ event: "turn.end", check: "total", ms: 5 }]);
	expect(readTimings(a).map((t) => t.ms)).toEqual([5]);
	expect(readTimings(b)).toEqual([]);
});
