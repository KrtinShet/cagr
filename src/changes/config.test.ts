import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/load";
import { loadRuleSet } from "../rules/rules";

const text = (id: string) => `[[changes.rules]]
id = "${id}"
kind = "add_only"
paths = ["migrations/**"]
reason = "Add a new migration instead."
examples.valid = [{changes = [{path = "migrations/new.sql", status = "A"}]}]
examples.invalid = [{changes = [{path = "migrations/old.sql", status = "D"}]}]
`;
test("root and pyproject combine nested fragments and empty arrays add without erasing", () => {
	for (const py of [false, true]) {
		const root = mkdtempSync(join(tmpdir(), "change-config-"));
		mkdirSync(join(root, ".cagr/nested"), { recursive: true });
		writeFileSync(
			join(root, py ? "pyproject.toml" : "cagr.toml"),
			py ? "[tool.cagr.changes]\nrules = []\n" : "[changes]\nrules = []\n",
		);
		writeFileSync(join(root, ".cagr/first.toml"), text("first"));
		writeFileSync(join(root, ".cagr/nested/second.toml"), text("second"));
		const config = loadConfig(root);
		expect(config?.changes.rules.map((r) => r.id)).toEqual(["first", "second"]);
		expect(config?.changes.rules[1]?.source).toBe(
			join(root, ".cagr/nested/second.toml"),
		);
		writeFileSync(join(root, ".cagr/nested/second.toml"), text("first"));
		expect(() => loadConfig(root)).toThrow("also used");
	}
});
test("change ids cannot shadow code or layout rules", () => {
	const root = mkdtempSync(join(tmpdir(), "change-id-"));
	mkdirSync(join(root, ".cagr/rules"), { recursive: true });
	writeFileSync(join(root, "cagr.toml"), text("same"));
	writeFileSync(
		join(root, ".cagr/rules/a.yml"),
		'id: same\nlanguage: typescript\nmessage: No logging\ninstead: Use the logger.\nrule:\n  pattern: console.log($X)\nexamples:\n  valid: ["const x = 1"]\n  invalid: ["console.log(1)"]\n',
	);
	const config = loadConfig(root);
	if (!config) throw Error("missing config");
	expect(() => loadRuleSet(config)).toThrow("also used");
});
