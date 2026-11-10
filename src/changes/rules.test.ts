import { expect, test } from "bun:test";
import { resolveConfig } from "../config/load";
import {
	type Change,
	type ChangeRule,
	evaluate,
	resolveChangeRules,
	targetPath,
	testChanges,
} from "./rules";
export const rule = (extra: Partial<ChangeRule> = {}): ChangeRule => ({
	id: "companion",
	kind: "requires",
	paths: ["src/**"],
	ignores: [],
	require: ["schema.json"],
	reason: "Generate and include schema.json.",
	source: "test",
	examples: {
		valid: [{ changes: [] }],
		invalid: [{ changes: [{ path: "src/a.ts", status: "M" }] }],
	},
	...extra,
});
const c = (
	path: string,
	status: Change["status"] = "M",
	regular = true,
): Change => ({ path, status, regular });
test("requires checks every companion, deletions trigger, only regular changed companions satisfy", () => {
	const r = rule({ require: ["schema.json", "docs/**"] });
	for (const companion of [
		[],
		[c("schema.json", "D")],
		[c("schema.json", "M", false)],
		[c("unrelated.md")],
	])
		expect(evaluate([r], [c("src/a.ts", "D"), ...companion])).toHaveLength(2);
	expect(
		evaluate([r], [c("src/a.ts"), c("schema.json"), c("docs/a.md", "A")]),
	).toHaveLength(0);
	expect(evaluate([r], [c("elsewhere.ts")])).toHaveLength(0);
});
test("sibling is per addition, ignores tests, expands exact paths literally", () => {
	const r = rule({
		kind: "sibling",
		paths: ["**/*.ts"],
		ignores: ["**/*.test.ts"],
		target: "{dir}/{name}.test.{ext}",
	});
	expect(targetPath(r.target ?? "", "x.test.ts")).toBe("x.test.test.ts");
	expect(
		evaluate([r], [c("a.ts", "A"), c("b.ts", "A"), c("a.test.ts")]),
	).toHaveLength(1);
	for (const status of ["A", "M"] as const)
		expect(
			evaluate([r], [c("a[1].ts", "A"), c("a[1].test.ts", status)]),
		).toHaveLength(0);
	expect(evaluate([r], [c("a.ts")])).toHaveLength(0);
	expect(evaluate([r], [c("a.ts", "A"), c("a.test.ts", "D")])).toHaveLength(1);
});
test("add_only permits branch new additions but freezes all baseline changes", () => {
	const r = rule({ kind: "add_only", paths: ["migrations/**"] });
	for (const status of ["M", "D", "T"] as const)
		expect(evaluate([r], [c("migrations/old.sql", status)])).toHaveLength(1);
	expect(evaluate([r], [c("migrations/new.sql", "A")])).toHaveLength(0);
});
test("fixtures run the evaluator and detect a wrong expectation", () => {
	expect(testChanges([rule()]).every((result) => result.ok)).toBe(true);
	expect(
		testChanges([
			rule({
				examples: {
					valid: [{ changes: [c("src/a.ts")] }],
					invalid: [{ changes: [] }],
				},
			}),
		]).every((result) => !result.ok),
	).toBe(true);
});
test("strict config rejects blank reason, unrelated keys, empty lists, bad fixtures and escaping templates", () => {
	const { source: _, ...r } = rule();
	for (const extra of [
		{ reason: " " },
		{ paths: [] },
		{ require: [] },
		{ kind: "pr_body" },
		{ when: "changed" },
		{ examples: { valid: [], invalid: [] } },
	])
		expect(() =>
			resolveConfig(
				{ changes: { rules: [{ ...r, ...extra }] } },
				"/no-repo",
				"cagr.toml",
			),
		).toThrow();
	for (const target of [
		"../test.ts",
		"/test.ts",
		"{oops}.ts",
		"*.ts",
		"a\\test.ts",
	])
		expect(() =>
			resolveChangeRules([rule({ kind: "sibling", target })], ["test"]),
		).toThrow();
	expect(() => resolveChangeRules([rule(), rule()], ["test"])).toThrow(
		"also used",
	);
	expect(() =>
		resolveChangeRules(
			[
				rule({
					examples: {
						valid: [{ changes: [{ ...c("x", "A"), before: "bad" }] }],
						invalid: [{ changes: [] }],
					},
				}),
			],
			["test"],
		),
	).toThrow();
});
