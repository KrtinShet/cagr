import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finding } from "../test/review";
import { evalReport, loadEvalCases, scoreCase } from "./eval";

const dir = (files: Record<string, string>) => {
	const root = mkdtempSync(join(tmpdir(), "gw-evals-"));
	for (const [name, text] of Object.entries(files))
		writeFileSync(join(root, name), text);
	return root;
};

test("cases load from TOML and need either a bug or clean = true", () => {
	const cases = loadEvalCases(
		dir({
			"b.toml": 'base = "x"\nhead = "y"\nclean = true\n',
			"a.toml":
				'name = "off by one"\nbase = "x"\nhead = "y"\n[[expect]]\nfile = "src/a.ts"\nline = 4\n',
			"notes.md": "ignored",
		}),
	);
	expect(cases.map((entry) => entry.name)).toEqual(["off by one", "b"]);
	expect(cases[0]?.expect).toEqual([{ file: "src/a.ts", line: 4 }]);
	expect(() =>
		loadEvalCases(dir({ "c.toml": 'base = "x"\nhead = "y"\n' })),
	).toThrow("give either [[expect]]");
	expect(() =>
		loadEvalCases(dir({ "d.toml": 'head = "y"\nclean = true\n' })),
	).toThrow("set base and head");
	expect(loadEvalCases("/no/such/dir")).toEqual([]);
});

const bug = {
	name: "x",
	base: "x",
	head: "y",
	expect: [{ file: "src/a.ts", line: 4 }],
	clean: false,
};

test("a bug counts as found by an Important finding in its file within 10 lines", () => {
	expect(scoreCase(bug, [finding({ line: 12 })])).toEqual({
		found: 1,
		expected: 1,
		falsePositives: 0,
	});
	expect(scoreCase(bug, [finding({ line: 30 })]).found).toBe(0);
	expect(scoreCase(bug, [finding({ severity: "nit" })]).found).toBe(0);
	expect(
		scoreCase(bug, [finding(), finding({ file: "src/b.ts" })]).falsePositives,
	).toBe(1);
	expect(
		scoreCase({ ...bug, expect: [], clean: true }, [finding()]).falsePositives,
	).toBe(1);
});

test("the report gives recall and compares with the last run", () => {
	const text = evalReport(
		[
			{ name: "a", found: 1, expected: 1, falsePositives: 0, error: null },
			{ name: "b", found: 0, expected: 1, falsePositives: 1, error: null },
		],
		[{ name: "a", found: 1, expected: 1, falsePositives: 0, error: null }],
	);
	expect(text).toContain("PASS  a");
	expect(text).toContain("MISS  b");
	expect(text).toContain("Recall 50%, false positives 1.");
	expect(text).toContain("Last run: recall 100%");
});
