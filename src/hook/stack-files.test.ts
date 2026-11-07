import { describe, expect, test } from "bun:test";
import { config } from "../test/config";
import { focusOnChanged, stackFiles, tidy, withFiles } from "./stack-files";

describe("stackFiles", () => {
	const repo = config({
		stack: [{ language: "python", paths: ["services/ml/**"] }],
	});
	test("keeps files under the stack's paths with its extensions", () => {
		expect(
			stackFiles(
				repo.stack[0] as never,
				[
					"/repo/services/ml/a.py",
					"/repo/services/ml/a.ts",
					"/repo/web/b.py",
					"/other/c.py",
				],
				repo,
			),
		).toEqual(["services/ml/a.py"]);
	});
});

test("withFiles quotes each path", () => {
	expect(withFiles("ruff check {files}", ["a.py", "it's here.py"])).toBe(
		`ruff check a.py 'it'\\''s here.py'`,
	);
});

describe("tidy", () => {
	test("drops repeated lines but keeps blank ones", () => {
		expect(tidy("a\n\nb\na\n\nb\nc")).toBe("a\n\nb\n\nc");
	});
	test("cuts long output and says so", () => {
		expect(tidy("x".repeat(50), 10)).toBe(
			"xxxxxxxxxx\n... (cut, run the check to see the rest)",
		);
	});
});

describe("focusOnChanged", () => {
	const output =
		"src/a.ts(3,1): error TS1\nsrc/other.ts(9,1): error TS2\nFound 2 errors.";
	test("hides lines about files the agent did not change", () => {
		expect(focusOnChanged(output, ["src/a.ts"])).toBe(
			"src/a.ts(3,1): error TS1\nFound 2 errors.\n(1 line about files you did not change hidden.)",
		);
	});
	test("keeps everything when every problem is elsewhere", () => {
		expect(focusOnChanged(output, ["src/b.ts"])).toBe(output);
	});
	test("matches path:line references", () => {
		expect(focusOnChanged("./a.py:1:1: E1\nb.py:2:1: E2", ["a.py"])).toBe(
			"./a.py:1:1: E1\n(1 line about files you did not change hidden.)",
		);
	});
});
