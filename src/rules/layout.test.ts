import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../config/load";
import { handle } from "../hook/handlers";
import { explainLayout, layoutFindings, stem, testLayoutRules } from "./layout";
import { loadLayoutRules, loadRuleSet, loadRules, RuleError } from "./rules";

// Two rules in one file, separated by ---, as a repo would write them.
const featureRules = `id: kebab-files
message: Feature files use kebab-case names.
instead: Rename the file to kebab-case, such as deal-card.tsx.
layout:
  files: ["src/features/**/*.{ts,tsx}"]
  ignores: ["**/*.test.*"]
  name: "^[a-z0-9]+(-[a-z0-9]+)*$"
examples:
  invalid: [src/features/deals/DealCard.tsx]
  valid: [src/features/deals/deal-card.tsx, src/features/deals/DealCard.test.tsx]
---
id: views-in-view-folder
message: Screens live in their feature's view folder.
instead: Move it to src/features/<feature>/view/<name>-view.tsx.
note: One folder per feature keeps a screen next to its parts.
layout:
  files: ["src/features/**/view.{ts,tsx}", "src/features/**/*-view.{ts,tsx}"]
  allowed: ["src/features/*/view/*-view.tsx"]
examples:
  invalid: [src/features/deals/deals-view.tsx]
  valid: [src/features/deals/view/deals-view.tsx]
`;

const codeRule = `id: no-console-log
language: typescript
message: console.log in app code.
instead: Use the logger.
rule:
  pattern: console.log($$$A)
examples:
  invalid: ["console.log(1)"]
  valid: ["log(1)"]
`;

async function repo(files: Record<string, string>) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "gw-layout-")));
	await mkdir(join(root, ".cagr/rules"), { recursive: true });
	for (const [name, text] of Object.entries(files))
		await writeFile(join(root, ".cagr/rules", name), text);
	return { root, config: resolveConfig({}, root, join(root, "cagr.toml")) };
}

describe("layoutFindings", async () => {
	const { config } = await repo({ "layout.yml": featureRules });
	const layout = loadLayoutRules(config);

	test("a name that is not kebab-case fires, tests are ignored", () => {
		const findings = layoutFindings(layout, [
			"src/features/deals/DealCard.tsx",
			"src/features/deals/deal-card.tsx",
			"src/features/deals/DealCard.test.tsx",
			"src/components/Button.tsx",
		]);
		expect(findings.map((f) => [f.rule, f.path])).toEqual([
			["kebab-files", "src/features/deals/DealCard.tsx"],
		]);
		expect(findings[0]?.detail).toContain('the name "DealCard"');
	});

	test("a view outside <feature>/view/ fires, one inside does not", () => {
		const findings = layoutFindings(layout, [
			"src/features/deals/deals-view.tsx",
			"src/features/deals/view/deals-view.tsx",
			"src/features/deals/view/nested/deals-view.tsx",
			"src/features/deals/view.tsx",
		]);
		expect(findings.map((f) => f.path)).toEqual([
			"src/features/deals/deals-view.tsx",
			"src/features/deals/view/nested/deals-view.tsx",
			"src/features/deals/view.tsx",
		]);
		expect(findings[0]?.detail).toContain("src/features/*/view/*-view.tsx");
	});

	test("stem drops every extension and a leading dot", () => {
		expect(stem("a/user-card.test.tsx")).toBe("user-card");
		expect(stem(".env.local")).toBe("env");
	});

	test("explain prints the rule, its file, note and examples", () => {
		const text = explainLayout(layout[1] as never);
		expect(text).toContain(
			`views-in-view-folder (layout rule from ${join(config.root, ".cagr/rules/layout.yml")})`,
		);
		expect(text).toContain("Allowed at: src/features/*/view/*-view.tsx");
		expect(text).toContain("Note: One folder per feature");
		expect(text).toContain("Fires on:\n  src/features/deals/deals-view.tsx");
	});
});

describe("loading", () => {
	test("layout and code rules load side by side from the rule dirs", async () => {
		const { config } = await repo({
			"layout.yml": featureRules,
			"code.yml": codeRule,
		});
		const set = loadRuleSet(config);
		expect(set.code.map((r) => r.id)).toEqual(["no-console-log"]);
		expect(set.layout.map((r) => r.id)).toEqual([
			"kebab-files",
			"views-in-view-folder",
		]);
		expect(loadRules(config).map((r) => r.id)).toEqual(["no-console-log"]);
	});

	test("[rules] dirs is honored", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "gw-layout-")));
		await mkdir(join(root, "checks"), { recursive: true });
		await writeFile(join(root, "checks/layout.yml"), featureRules);
		const config = resolveConfig(
			{ rules: { dirs: ["checks"] } },
			root,
			join(root, "cagr.toml"),
		);
		expect(loadLayoutRules(config)).toHaveLength(2);
	});

	const bad = async (text: string) => {
		const { config } = await repo({ "bad.yml": text });
		return expect(() => loadRuleSet(config));
	};
	const rule = (layout: string, extra = "") =>
		`id: x\nmessage: m\ninstead: i\n${extra}layout:\n${layout}\nexamples:\n  invalid: [a]\n  valid: [b]\n`;

	test("a rule needs name or allowed", async () => {
		(await bad(rule('  files: ["**"]'))).toThrow(
			"checks nothing. Set layout.name",
		);
	});

	test("files is required", async () => {
		(await bad(rule("  name: a"))).toThrow('"layout.files" is required');
	});

	test("an invalid name pattern is an error", async () => {
		(await bad(rule('  files: ["**"]\n  name: "("'))).toThrow(
			"is not a valid regular expression",
		);
	});

	test("an unknown key, or a code rule key, is an error", async () => {
		(await bad(rule('  files: ["**"]\n  name: a\n  folder: x'))).toThrow(
			'"layout.folder" is not a layout key',
		);
		(
			await bad(rule('  files: ["**"]\n  name: a', "language: typescript\n"))
		).toThrow("checks paths, not code");
	});

	test("message, instead and both kinds of example are required", async () => {
		(await bad('id: x\nlayout:\n  files: ["**"]\n  name: a\n')).toThrow(
			'"instead" is required',
		);
		(
			await bad(
				'id: x\nmessage: m\ninstead: i\nlayout:\n  files: ["**"]\n  name: a\nexamples:\n  invalid: [a]\n',
			)
		).toThrow('"examples.valid" needs at least one repo-relative path');
	});

	test("an id may not be a guard id or repeat across either kind", async () => {
		(
			await bad(
				rule('  files: ["**"]\n  name: a').replace("id: x", "id: force-push"),
			)
		).toThrow("is a built-in guard");
		const { config } = await repo({
			"a.yml": rule('  files: ["**"]\n  name: a').replace(
				"id: x",
				"id: no-console-log",
			),
			"b.yml": codeRule,
		});
		expect(() => loadRuleSet(config)).toThrow(RuleError);
		expect(() => loadRules(config)).toThrow(
			'id "no-console-log" is also used in',
		);
	});

	test("[[layout]] in cagr.toml is an error that says where the rules went", () => {
		expect(() =>
			resolveConfig(
				{ layout: [{ id: "x", files: ["**"], name: "a" }] },
				"/repo",
				"cagr.toml",
			),
		).toThrow(
			"[[layout]] moved out of the config, into rule files. Put each layout rule in a .cagr/rules/*.yml file",
		);
	});
});

describe("examples", () => {
	test("every example passes in a correct rule", async () => {
		const { config } = await repo({ "layout.yml": featureRules });
		const results = testLayoutRules(loadLayoutRules(config));
		expect(results).toHaveLength(5);
		expect(results.every((result) => result.ok)).toBe(true);
	});

	test("an invalid example that does not fire and a valid one that does both fail", async () => {
		const { config } = await repo({
			"layout.yml": featureRules
				.replace(
					"invalid: [src/features/deals/DealCard.tsx]",
					"invalid: [src/other/DealCard.tsx]",
				)
				.replace(
					"valid: [src/features/deals/view/deals-view.tsx]",
					"valid: [src/features/deals/deals-view.tsx]",
				),
		});
		const failed = testLayoutRules(loadLayoutRules(config)).filter(
			(result) => !result.ok,
		);
		expect(failed.map((f) => [f.rule, f.kind, f.example])).toEqual([
			["kebab-files", "invalid", "src/other/DealCard.tsx"],
			["views-in-view-folder", "valid", "src/features/deals/deals-view.tsx"],
		]);
	});
});

describe("hooks", () => {
	async function setup(rules = featureRules) {
		const { root, config } = await repo({ "layout.yml": rules });
		const dir = join(root, "src/features/deals");
		await mkdir(dir, { recursive: true });
		const input = (
			event: "file.before_edit" | "file.after_edit",
			file: string,
		) => ({
			event,
			sessionId: `test-${crypto.randomUUID()}`,
			cwd: root,
			command: null,
			files: [join(root, file)],
		});
		return { root, dir, config, input };
	}

	test("creating a file with a bad name is denied with the fix", async () => {
		const { config, input } = await setup();
		const decision = await handle(
			input("file.before_edit", "src/features/deals/DealCard.tsx"),
			config,
		);
		expect(decision).toEqual({
			kind: "deny",
			reason:
				'Do not create src/features/deals/DealCard.tsx: Feature files use kebab-case names. (the name "DealCard" does not match /^[a-z0-9]+(-[a-z0-9]+)*$/.) Instead: Rename the file to kebab-case, such as deal-card.tsx. (cagr: kebab-files)',
		});
	});

	test("a new path that breaks two rules gets both fixes at once", async () => {
		const { config, input } = await setup();
		const decision = await handle(
			input("file.before_edit", "src/features/deals/Deals-view.tsx"),
			config,
		);
		expect(decision.kind).toBe("deny");
		const reason = "reason" in decision ? decision.reason : "";
		expect(reason).toContain("Feature files use kebab-case names.");
		expect(reason).toContain(
			"Also (views-in-view-folder): Screens live in their feature's view folder.",
		);
	});

	test("editing an existing file is allowed before, reported after", async () => {
		const { dir, config, input } = await setup();
		await writeFile(join(dir, "DealCard.tsx"), "export {};\n");
		const file = "src/features/deals/DealCard.tsx";
		expect(await handle(input("file.before_edit", file), config)).toEqual({
			kind: "allow",
		});
		const after = await handle(input("file.after_edit", file), config);
		expect(after.kind).toBe("block");
		expect("reason" in after && after.reason).toContain(
			`## Layout\n${file} kebab-files: Feature files use kebab-case names.`,
		);
	});

	test("turn.end reports a file the turn put in the wrong place", async () => {
		const { root, dir, config } = await setup();
		const file = join(dir, "deals-view.tsx");
		await writeFile(file, "export {};\n");
		const base = {
			sessionId: `test-${crypto.randomUUID()}`,
			cwd: root,
			command: null,
		};
		await handle({ ...base, event: "file.after_edit", files: [file] }, config);
		const stop = await handle(
			{ ...base, event: "turn.end", files: [] },
			config,
		);
		expect(stop.kind).toBe("block");
		expect("reason" in stop && stop.reason).toContain(
			"src/features/deals/deals-view.tsx views-in-view-folder: Screens live in their feature's view folder. (it may only live at src/features/*/view/*-view.tsx.)",
		);
	});

	test("a good new path is allowed", async () => {
		const { config, input } = await setup();
		expect(
			await handle(
				input("file.before_edit", "src/features/deals/view/deals-view.tsx"),
				config,
			),
		).toEqual({ kind: "allow" });
	});

	test("a broken rule file does not block creating a file", async () => {
		const { config, input } = await setup(`${featureRules}---\nid: [\n`);
		expect(
			await handle(
				input("file.before_edit", "src/features/deals/DealCard.tsx"),
				config,
			),
		).toEqual({ kind: "allow" });
	});
});
