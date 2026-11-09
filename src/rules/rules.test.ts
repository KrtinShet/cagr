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

// superagent's ARCH003 as a code rule: the import source is a string, so match
// its text with a regex, and scope the rule to the importing files with `files`.
const componentImports = `id: components-stay-shared
language: typescript
files: ["apps/web/src/components/**"]
message: Shared components may not import from $SRC.
instead: Pass the data in as props, or move the code into src/sections/<feature>/.
rule:
  kind: string
  regex: "^['\\"]@/(sections|app|api|server|layouts|store)/"
  pattern: $SRC
  inside:
    any:
      - kind: import_statement
      - kind: export_statement
examples:
  invalid:
    - import { DealCard } from "@/sections/deals/deal-card";
    - export { db } from '@/server/db';
  valid:
    - import { Button } from "@/components/button";
    - import { formatDate } from "@/utils/date";
    - const label = "@/sections/x";
`;

describe("import boundaries", () => {
	test("examples behave", async () => {
		const { config } = await repo({ "a.yml": componentImports });
		const results = await testRules(loadRules(config));
		expect(results.filter((r) => !r.ok)).toEqual([]);
	});

	test("fires in components only", async () => {
		const { root, config } = await repo({ "a.yml": componentImports });
		const text =
			'import { DealCard } from "@/sections/deals/deal-card";\nexport const A = () => <DealCard />;\n';
		for (const dir of ["components/ui", "sections/deals"]) {
			await mkdir(join(root, "apps/web/src", dir), { recursive: true });
			await writeFile(join(root, "apps/web/src", dir, "a.tsx"), text);
		}
		const findings = await findInFiles(
			loadRules(config),
			["components/ui/a.tsx", "sections/deals/a.tsx"].map((p) =>
				join(root, "apps/web/src", p),
			),
			root,
		);
		expect(findings.map(formatFinding)).toEqual([
			'apps/web/src/components/ui/a.tsx:1:26 components-stay-shared: Shared components may not import from "@/sections/deals/deal-card". Instead: Pass the data in as props, or move the code into src/sections/<feature>/.',
		]);
	});
});

// superagent's ARCH008: JSX kinds exist in the TSX grammar, not in the plain TypeScript one.
const jsxRule = `id: pages-render-views
language: typescript
message: <$TAG> does not belong in a page.
instead: Render a *View screen.
rule:
  any: [{ kind: jsx_opening_element }, { kind: jsx_self_closing_element }]
  has:
    field: name
    pattern: $TAG
    not: { regex: "View$" }
examples:
  invalid: ["export default function Page() { return <div/>; }"]
  valid: ["export default function Page() { return <HomeView/>; }"]
`;

describe("languages", () => {
	test("JSX kinds under typescript check .tsx files, and skip .ts files", async () => {
		const { root, config } = await repo({ "a.yml": jsxRule });
		const results = await testRules(loadRules(config));
		expect(results.filter((r) => !r.ok)).toEqual([]);
		await writeFile(join(root, "page.tsx"), "export const P = () => <div/>;\n");
		await writeFile(join(root, "page.ts"), "export const p = 1;\n");
		const findings = await findInFiles(
			loadRules(config),
			[join(root, "page.tsx"), join(root, "page.ts")],
			root,
		);
		expect(findings.map((f) => [f.path, f.message])).toEqual([
			["page.tsx", "<div> does not belong in a page."],
		]);
	});

	test("a kind no parser of the language has is a rule file problem, not a crash", async () => {
		const { config } = await repo({
			"a.yml": jsxRule.replace("jsx_opening_element", "jsx_openin_element"),
		});
		const rules = loadRules(config);
		await expect(testRules(rules)).rejects.toThrow(RuleError);
		await expect(testRules(rules)).rejects.toThrow(
			"(pages-render-views): the rule does not work for typescript: Rule contains invalid kind matcher: Invalid Kind: Kind `jsx_openin_element` is invalid",
		);
	});

	test("a bad regex is a rule file problem in findInFiles too", async () => {
		const { root, config } = await repo({
			"a.yml": noConsole.replace(
				"pattern: console.log($$$ARGS)",
				'regex: "(["',
			),
		});
		await writeFile(join(root, "a.ts"), "console.log(1);\n");
		await expect(
			findInFiles(loadRules(config), [join(root, "a.ts")], root),
		).rejects.toThrow("Rule files have problems:");
	});

	test("a list of languages checks every language's files", async () => {
		const { root, config } = await repo({
			"a.yml": noConsole.replace(
				"language: typescript",
				"language: [typescript, JavaScript]",
			),
		});
		const rules = loadRules(config);
		expect(rules[0]?.languages).toEqual(["typescript", "javascript"]);
		for (const name of ["a.ts", "b.tsx", "c.js", "d.jsx", "e.mjs", "f.py"])
			await writeFile(join(root, name), "console.log(1);\n");
		const findings = await findInFiles(
			rules,
			["a.ts", "b.tsx", "c.js", "d.jsx", "e.mjs", "f.py"].map((n) =>
				join(root, n),
			),
			root,
		);
		expect(findings.map((f) => f.path)).toEqual([
			"a.ts",
			"b.tsx",
			"c.js",
			"d.jsx",
			"e.mjs",
		]);
	});

	test("a language in the list the rule's kinds do not exist in is a problem", async () => {
		const { config } = await repo({
			"a.yml": `id: typed
language: [typescript, javascript]
message: a type annotation.
instead: Remove it.
rule:
  kind: type_annotation
examples:
  invalid: ["const a: number = 1;"]
  valid: ["const a = 1;"]
`,
		});
		await expect(testRules(loadRules(config))).rejects.toThrow(
			'the rule does not work for javascript: Rule contains invalid kind matcher: Invalid Kind: Kind `type_annotation` is invalid. Drop javascript from "language", or split the rule.',
		);
	});

	test("language must name known languages", async () => {
		const { config } = await repo({
			"a.yml": noConsole.replace(
				"language: typescript",
				"language: [typescript, cobol]",
			),
			"b.yml": noPrint.replace("language: python", "language: []"),
		});
		expect(() => loadRules(config)).toThrow("or a list of them");
	});
});
