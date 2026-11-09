import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveConfig } from "../config/load";
import {
	crosses,
	ImportConfigError,
	parseJsonc,
	resolveImport,
} from "./imports";
import {
	findInFiles,
	formatFinding,
	loadRules,
	RuleError,
	testRules,
} from "./rules";

async function repo(files: Record<string, string>) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "gw-imports-")));
	for (const [name, text] of Object.entries(files)) {
		await mkdir(dirname(join(root, name)), { recursive: true });
		await writeFile(join(root, name), text);
	}
	return { root, config: resolveConfig({}, root, join(root, "cagr.toml")) };
}

const tsconfig = `{
  // Comments and trailing commas, as tsconfig allows.
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "paths": { "@/*": ["./src/*"], "~lib": ["./src/lib/index.ts"], },
  },
}`;

describe("resolveImport", () => {
	test("relative, alias, extensionless, index and package sources", async () => {
		const { root } = await repo({
			"apps/web/tsconfig.json": tsconfig,
			"apps/web/tsconfig.base.json": "{}",
			"apps/web/src/server/db.ts": "",
			"apps/web/src/server/store/index.ts": "",
			"apps/web/src/lib/index.ts": "",
		});
		const from = "apps/web/src/components/ui/button.tsx";
		expect(resolveImport(root, from, "../../server/db")).toBe(
			"apps/web/src/server/db.ts",
		);
		expect(resolveImport(root, from, "@/server/store")).toBe(
			"apps/web/src/server/store/index.ts",
		);
		expect(resolveImport(root, from, "@/server/db.js")).toBe(
			"apps/web/src/server/db.ts",
		);
		expect(resolveImport(root, from, "@/sections/x")).toBe(
			"apps/web/src/sections/x",
		);
		expect(resolveImport(root, from, "~lib")).toBe("apps/web/src/lib/index.ts");
		expect(resolveImport(root, from, "swr/mutation")).toBe("swr/mutation");
		expect(resolveImport(root, "src/a.ts", "@/server/db")).toBe("@/server/db");
	});

	test("paths from an extended config, relative to that config", async () => {
		const { root } = await repo({
			"apps/web/tsconfig.json": '{ "extends": "../../tsconfig.base" }',
			"tsconfig.base.json":
				'{ "compilerOptions": { "paths": { "#/*": ["apps/web/src/*"] } } }',
		});
		expect(resolveImport(root, "apps/web/src/a.ts", "#/server/db")).toBe(
			"apps/web/src/server/db",
		);
	});

	test("baseUrl resolves bare sources that exist under it", async () => {
		const { root } = await repo({
			"jsconfig.json": '{ "compilerOptions": { "baseUrl": "src" } }',
			"src/server/db.js": "",
		});
		expect(resolveImport(root, "src/a.js", "server/db")).toBe(
			"src/server/db.js",
		);
		expect(resolveImport(root, "src/a.js", "react")).toBe("react");
	});

	test("tsconfig text: BOM, comments after a trailing comma, commas and slashes in strings", () => {
		expect(
			parseJsonc(
				'\uFEFF{ "a": ",}", "b": "//x", "c": [1, /* y */ 2, // z\n], }',
			),
		).toEqual({ a: ",}", b: "//x", c: [1, 2] });
	});

	test("a tsconfig that cannot be read is a rule problem, not a silent skip", async () => {
		for (const text of ["{ nope", "null", "[]"]) {
			const { root } = await repo({ "tsconfig.json": text });
			expect(() => resolveImport(root, "src/a.ts", "@/x")).toThrow(
				ImportConfigError,
			);
			expect(() => resolveImport(root, "src/a.ts", "@/x")).toThrow(
				"Import rules cannot read",
			);
		}
	});

	test("a relative extends that does not exist is a rule problem", async () => {
		const { root } = await repo({
			"tsconfig.json": '{ "extends": "./configs/base" }',
		});
		expect(() => resolveImport(root, "src/a.ts", "@/x")).toThrow(
			"it extends ./configs/base, which does not exist",
		);
	});

	test("extends without .json finds the .json file", async () => {
		const { root } = await repo({
			"tsconfig.json": '{ "extends": "./configs/base" }',
			"configs/base.json":
				'{ "compilerOptions": { "paths": { "@/*": ["../src/*"] } } }',
		});
		expect(resolveImport(root, "src/a.ts", "@/x")).toBe("src/x");
	});

	test("a catch-all * alias keeps package names when nothing local exists", async () => {
		const { root } = await repo({
			"tsconfig.json":
				'{ "compilerOptions": { "paths": { "*": ["./types/*"] } } }',
			"types/legacy/index.d.ts": "",
		});
		expect(resolveImport(root, "src/a.ts", "swr/mutation")).toBe(
			"swr/mutation",
		);
		expect(resolveImport(root, "src/a.ts", "legacy")).toBe(
			"types/legacy/index.d.ts",
		);
	});

	test("paths from a config outside the repo stay outside it", async () => {
		const { root } = await repo({
			"shared/tsconfig.json":
				'{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
			"repo/tsconfig.json": '{ "extends": "../shared/tsconfig.json" }',
		});
		expect(resolveImport(join(root, "repo"), "a.ts", "@/server/db")).toBe(
			"../shared/src/server/db",
		);
	});

	test("forbid with allow exceptions", () => {
		const boundary = {
			forbid: ["apps/web/src/sections/**", "swr", "swr/**"],
			allow: ["apps/web/src/sections/*/view/**"],
		};
		expect(crosses(boundary, "apps/web/src/sections/items/form.tsx")).toBe(
			true,
		);
		expect(crosses(boundary, "apps/web/src/sections/items/view/a.tsx")).toBe(
			false,
		);
		expect(crosses(boundary, "swr/mutation")).toBe(true);
		expect(crosses(boundary, "swr-like")).toBe(false);
		// The whole target, not its last segment.
		expect(crosses(boundary, "@acme/swr")).toBe(false);
		expect(crosses(boundary, "apps/web/src/lib/swr")).toBe(false);
		expect(
			crosses(
				{ forbid: ["/apps/web/src/sections/**"], allow: [] },
				"apps/web/src/sections/a.ts",
			),
		).toBe(true);
		expect(
			crosses(
				{ forbid: ["apps/**"], allow: ["types.ts"] },
				"apps/web/src/server/types.ts",
			),
		).toBe(true);
	});
});

const boundaryRule = `id: components-stay-generic
files: ["apps/web/src/components/**"]
message: Shared components may not import $TARGET ($SRC).
instead: Pass the data in as props.
imports:
  forbid: ["apps/web/src/sections/**", "apps/web/src/server/**"]
  allow: ["apps/web/src/server/types.ts"]
examples:
  invalid:
    - { path: apps/web/src/components/a.tsx, code: 'import { db } from "@/server/db";' }
    - { path: apps/web/src/components/a.tsx, code: 'export * from "../sections/items/form";' }
    - { path: apps/web/src/components/a.js, code: 'const db = require("../server/db");' }
    - { path: apps/web/src/components/ui/a.ts, code: 'const s = await import("../../server/store");' }
  valid:
    - { path: apps/web/src/components/a.tsx, code: 'import type { Row } from "@/server/types";' }
    - { path: apps/web/src/components/a.tsx, code: 'const label = "@/server/db";' }
    - { path: apps/web/src/sections/items/a.tsx, code: 'import { db } from "@/server/db";' }
    - { path: apps/web/src/components/a.tsx, code: 'import { cn } from "@/utils/cn";' }
`;

const files = {
	"apps/web/tsconfig.json":
		'{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
	"apps/web/src/server/db.ts": "",
	"apps/web/src/server/types.ts": "",
	"apps/web/src/server/store/index.ts": "",
	"apps/web/src/sections/items/form.tsx": "",
};

describe("imports rules", () => {
	test("examples resolve aliases and relative paths, and default to ts and js", async () => {
		const { root, config } = await repo({
			...files,
			".cagr/rules/a.yml": boundaryRule,
		});
		const rules = loadRules(config);
		expect(rules[0]?.languages).toEqual(["typescript", "javascript"]);
		const results = await testRules(rules, root);
		expect(results.filter((r) => !r.ok)).toEqual([]);
	});

	test("findings name the resolved module", async () => {
		const { root, config } = await repo({
			...files,
			".cagr/rules/a.yml": boundaryRule,
			"apps/web/src/components/card.tsx":
				'import { db } from "../server/db";\nimport { Row } from "@/server/types";\nexport const A = () => <div />;\n',
		});
		const findings = await findInFiles(
			loadRules(config),
			[join(root, "apps/web/src/components/card.tsx")],
			root,
		);
		expect(findings.map(formatFinding)).toEqual([
			'apps/web/src/components/card.tsx:1:20 components-stay-generic: Shared components may not import apps/web/src/server/db.ts ("../server/db"). Instead: Pass the data in as props.',
		]);
	});

	test("rule, other languages and a bad imports block are problems", async () => {
		const { config } = await repo({
			".cagr/rules/a.yml": boundaryRule
				.replace(
					"imports:\n",
					"language: python\nrule: { kind: string }\nimports:\n",
				)
				.replace("  allow:", "  except:"),
			".cagr/rules/b.yml": boundaryRule
				.replace("id: components-stay-generic", "id: b")
				.replace(/ {2}forbid: .*\n/, ""),
		});
		let message = "";
		try {
			loadRules(config);
		} catch (error) {
			expect(error).toBeInstanceOf(RuleError);
			message = (error as Error).message;
		}
		expect(message).toContain('"rule" does not go with "imports"');
		expect(message).toContain(
			'an "imports" rule checks typescript, tsx, javascript only',
		);
		expect(message).toContain('"imports.except" is not an imports key');
		expect(message).toContain('(b): "imports.forbid" is required');
	});
});

test("a generated tsconfig that is missing fails only the import rule, and says to generate it", async () => {
	const { root, config } = await repo({
		...files,
		"apps/web/tsconfig.json": '{ "extends": "./.svelte-kit/tsconfig.json" }',
		".cagr/rules/a.yml": boundaryRule,
		".cagr/rules/b.yml": `id: no-console
language: typescript
message: console.log in app code.
instead: Use the logger.
rule: { pattern: console.log($$$A) }
examples:
  invalid: ["console.log(1)"]
  valid: ["log(1)"]
`,
		"apps/web/src/components/card.tsx":
			'import { a } from "@/server/db";\nimport { b } from "@/server/x";\nconsole.log(1);\n',
	});
	const findings = await findInFiles(
		loadRules(config),
		[join(root, "apps/web/src/components/card.tsx")],
		root,
	);
	expect(findings.map((f) => [f.rule, f.line])).toEqual([
		["components-stay-generic", 1],
		["no-console", 3],
	]);
	expect(findings[0]?.message).toContain(
		'Could not check "@/server/db": Import rules cannot read',
	);
	expect(findings[0]?.instead).toContain("run its sync or prepare step");
});

test("rules test fails examples it could not check, valid and invalid, with the reason", async () => {
	const { root, config } = await repo({
		...files,
		"apps/web/tsconfig.json": '{ "extends": "./.nuxt/tsconfig.json" }',
		".cagr/rules/a.yml": boundaryRule,
	});
	const results = await testRules(loadRules(config), root);
	const alias = results.filter((r) =>
		r.skipped?.includes("it could not be checked"),
	);
	// Every in-scope example with an alias import, valid or invalid.
	expect(alias.map((r) => r.example)).toEqual([
		'import { db } from "@/server/db";',
		'import type { Row } from "@/server/types";',
		'import { cn } from "@/utils/cn";',
	]);
	for (const result of alias) {
		expect(result.ok).toBe(false);
		expect(result.skipped).toContain("nuxi prepare");
	}
	expect(alias.map((r) => r.kind)).toContain("valid");
	expect(alias.map((r) => r.kind)).toContain("invalid");
});
