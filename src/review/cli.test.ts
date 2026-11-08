import { expect, test } from "bun:test";
import { parseReviewArgs } from "./cli";

test("--scan takes the globs up to the next option, wherever the options sit", () => {
	expect(parseReviewArgs(["--issue", "--scan", "src/**"])).toMatchObject({
		scan: ["src/**"],
		issue: true,
	});
	expect(
		parseReviewArgs(["--scan", "src/**", "lib/**", "--effort", "deep"]),
	).toMatchObject({ scan: ["src/**", "lib/**"], effort: "deep" });
	expect(parseReviewArgs(["--base", "dev", "--full"])).toMatchObject({
		base: "dev",
		full: true,
		scan: undefined,
	});
});

test("--scan with no globs, or an unknown option, is an error", () => {
	expect(() => parseReviewArgs(["--scan", "--issue"])).toThrow(
		"Name the globs to scan",
	);
	expect(() => parseReviewArgs(["--fast"])).toThrow("Unknown option --fast");
});
