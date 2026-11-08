import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../config/load";
import {
	findInFiles,
	formatFinding,
	loadRules,
	RuleError,
	testRules,
} from "./rules";

const noConsole = `id: no-console-log
language: typescript
message: console.log($$$ARGS) leaves debug output in app code.
instead: Use \`logger.info\` from src/lib/logger.ts.
ignores: ["scripts/**"]
rule:
  pattern: console.log($$$ARGS)
examples:
  invalid:
    - console.log("hi")
  valid:
    - logger.info("hi")
`;
const noPrint = `id: no-print
language: python
message: print() in library code.
instead: Use \`logging.getLogger(__name__)\`.
rule:
  pattern: print($$$A)
examples:
  invalid: ["print('x')"]
  valid: ["log.info('x')"]
`;

async function repo(rules: Record<string, string>) {
	const root = await mkdtemp(join(tmpdir(), "gw-rules-"));
	await mkdir(join(root, ".cagr/rules"), { recursive: true });
	for (const [name, text] of Object.entries(rules))
		await writeFile(join(root, ".cagr/rules", name), text);
	return { root, config: resolveConfig({}, root, "test.toml") };
}

describe("loading", () => {
	test("reads every rule file", async () => {
		const { config } = await repo({ "a.yml": noConsole, "b.yaml": noPrint });
		expect(loadRules(config).map((rule) => rule.id)).toEqual([
			"no-console-log",
			"no-print",
		]);
	});

	test("requires message, instead and both kinds of example", async () => {
		const { config } = await repo({
			"bad.yml":
				"id: bad\nlanguage: typescript\nmessage: x\nrule:\n  pattern: x\nexamples:\n  invalid: [x]\n",
		});
		expect(() => loadRules(config)).toThrow(RuleError);
		try {
			loadRules(config);
		} catch (error) {
			const message = (error as Error).message;
			expect(message).toContain(
				'"instead" is required: say what to use instead',
			);
			expect(message).toContain(
				'"examples.valid" needs at least one code example',
			);
			expect(message).not.toContain('"examples.invalid"');
		}
	});

	test("rejects unknown keys, languages, duplicate ids and guard ids", async () => {
		const { config } = await repo({
			"a.yml": noConsole,
			"b.yml": noConsole,
			"c.yml": noPrint
				.replace("id: no-print", "id: force-push")
				.replace("language: python", "language: cobol"),
			"d.yml": `${noPrint.replace("id: no-print", "id: d")}severity: error\n`,
		});
		const message = (() => {
			try {
				loadRules(config);
				return "";
			} catch (error) {
				return (error as Error).message;
			}
		})();
		expect(message).toContain('id "no-console-log" is also used in');
		expect(message).toContain('"language" must be one of');
		expect(message).toContain('"severity" is not a rule key');
	});

	test("a built-in guard id is refused", async () => {
		const { config } = await repo({
			"a.yml": noPrint.replace("id: no-print", "id: force-push"),
		});
		expect(() => loadRules(config)).toThrow(
			'id "force-push" is a built-in guard',
		);
	});
});

describe("finding", () => {
	test("reports findings in the given files with the fix", async () => {
		const { root, config } = await repo({
			"a.yml": noConsole,
			"b.yml": noPrint,
		});
		await mkdir(join(root, "src"));
		await mkdir(join(root, "scripts"));
		await writeFile(
			join(root, "src/a.ts"),
			"const a = 1;\n  console.log(a, 2);\n",
		);
		await writeFile(
			join(root, "src/b.tsx"),
			"export const B = () => { console.log(1); return <div/>; };\n",
		);
		await writeFile(join(root, "scripts/c.ts"), "console.log(1);\n");
		await writeFile(join(root, "src/d.py"), "def f():\n    print('x')\n");
		const findings = await findInFiles(
			loadRules(config),
			["src/a.ts", "src/b.tsx", "scripts/c.ts", "src/d.py", "missing.ts"].map(
				(p) => join(root, p),
			),
			root,
		);
		expect(findings.map(formatFinding)).toEqual([
			"src/a.ts:2:3 no-console-log: console.log(a, 2) leaves debug output in app code. Instead: Use `logger.info` from src/lib/logger.ts.",
			"src/b.tsx:1:26 no-console-log: console.log(1) leaves debug output in app code. Instead: Use `logger.info` from src/lib/logger.ts.",
			"src/d.py:2:5 no-print: print() in library code. Instead: Use `logging.getLogger(__name__)`.",
		]);
	});

	test("files outside the root are skipped", async () => {
		const { config } = await repo({ "a.yml": noConsole });
		expect(
			await findInFiles(loadRules(config), ["/elsewhere/a.ts"], config.root),
		).toEqual([]);
	});
});

describe("rules test", () => {
	test("passes when examples behave", async () => {
		const { config } = await repo({ "a.yml": noConsole, "b.yml": noPrint });
		expect(
			(await testRules(loadRules(config))).every((result) => result.ok),
		).toBe(true);
	});

	test("fails an invalid example that does not fire, and a valid one that does", async () => {
		const { config } = await repo({
			"a.yml": noConsole
				.replace('- console.log("hi")', '- console.error("hi")')
				.replace('- logger.info("hi")', "- console.log(1)"),
		});
		const results = await testRules(loadRules(config));
		expect(results.map((r) => [r.kind, r.ok])).toEqual([
			["invalid", false],
			["valid", false],
		]);
	});
});
