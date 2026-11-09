import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveConfig } from "../config/load";
import { crosses, resolveImport } from "./imports";
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
