import { expect, test } from "bun:test";
import { join } from "node:path";
import { resolveConfig } from "../config/load";
import { tempRepo } from "../test/repo";
import {
	addedLines,
	checkSuppressions,
	suppressionFindings,
} from "./lint-suppression";

const config = (raw = {}) =>
	resolveConfig(
		{ extends: ["recommended"], ...raw },
		"/repo",
		"/repo/cagr.toml",
	);
const scan = (file: string, text: string, added = new Set([1])) =>
	suppressionFindings(file, text, added, config());

for (const [file, comments] of [
	[
		"a.ts",
		[
			"// eslint-disable",
			"/* eslint-disable-next-line x */",
			"x(); // eslint-disable-line x",
			"// @ts-ignore",
			"// @ts-nocheck",
			"// @ts-expect-error",
			"// biome-ignore lint/x: reason",
			"// oxlint-disable",
			"// oxlint-disable-next-line x",
			"// prettier-ignore",
		],
	],
	[
		"a.py",
		[
			"x() # noqa",
			"# type: ignore[x]",
			"# pyright: ignore[x]",
			"# pylint: disable=x",
			"# ruff: noqa",
		],
	],
	["a.go", ["//nolint:x", "//lint:ignore X reason"]],
	["a.rs", ["#[allow(dead_code)]", "#![allow(unused)]"]],
] as const) {
	for (const comment of comments)
		test(`${file}: ${comment}`, () => {
			expect(scan(file, comment)).toMatchObject([
				{
					id: "lint-suppression",
					file,
					line: 1,
					reason: expect.stringContaining(comment),
				},
			]);
		});
}

test("only added lines are reported, including inside multiline comments", () => {
	const text = "/*\n * eslint-disable\n */\n// @ts-ignore\n";
	expect(scan("a.ts", text, new Set([2]))).toMatchObject([{ line: 2 }]);
	expect(scan("a.ts", text, new Set([1, 3]))).toEqual([]);
	expect([...addedLines("@@ -1 +1,2 @@\n@@ -6 +7,0 @@\n@@ -8 +9 @@")]).toEqual([
		1, 2, 9,
	]);
});

test("strings, ordinary comments and unsupported extensions are left alone", () => {
	for (const [file, text] of [
		["a.ts", 'const a = "// eslint-disable";'],
		["a.ts", "const a = `\n// @ts-ignore\n`;"],
		["a.py", 'a = "# noqa"'],
		["a.py", 'a = """\n# noqa\n"""'],
		["a.go", 'var a = "//nolint"'],
		["a.rs", 'let a = "#[allow(unused)]";'],
		["a.rs", "// #[allow(unused)]"],
		["a.rs", "/* #[allow(unused)] */"],
		["a.ts", "// regular comment"],
		["a.txt", "// eslint-disable"],
	])
		expect(scan(file ?? "", text ?? "", new Set([1, 2, 3]))).toEqual([]);
});

test("allow globs and disabled config", () => {
	for (const raw of [
		{ suppressions: { enabled: false } },
		{ suppressions: { allow: ["generated/**"] } },
		{ suppressions: { allow: ["*.ts"] } },
	]) {
		expect(
			suppressionFindings(
				"generated/a.ts",
				"// @ts-ignore",
				new Set([1]),
				config(raw),
			),
		).toEqual([]);
	}
	expect(scan("other/a.ts", "// @ts-ignore")).toHaveLength(1);
	expect(resolveConfig({}, "/repo", "/repo/cagr.toml").suppressions).toEqual({
		enabled: false,
		allow: [],
	});
});

test("HEAD comparison includes staged and untracked additions but preserves existing lines", async () => {
	const repo = await tempRepo();
	const cfg = resolveConfig(
		{ extends: ["recommended"] },
		repo.root,
		join(repo.root, "cagr.toml"),
	);
	await repo.commit("feat: baseline", { "a.ts": "// @ts-ignore\nx();\n" });
	await repo.write("a.ts", "// @ts-ignore\nx();\n// prettier-ignore\ny();\n");
	await repo.git("add", "a.ts");
	await repo.write("new.py", "# noqa\n");
	const start = performance.now();
	const findings = await checkSuppressions(cfg, [
		join(repo.root, "a.ts"),
		join(repo.root, "new.py"),
	]);
	expect(findings.map(({ file, line }) => ({ file, line }))).toEqual([
		{ file: "a.ts", line: 3 },
		{ file: "new.py", line: 1 },
	]);
	expect(performance.now() - start).toBeLessThan(1000);
});

test("dedicated lint configs are protected at any depth, shared manifests stay editable", () => {
	const cfg = config();
	for (const name of [
		"biome.json",
		"biome.jsonc",
		"eslint.config.mjs",
		".eslintrc.json",
		"ruff.toml",
		".ruff.toml",
		"mypy.ini",
		".golangci.yaml",
		".golangci.yml",
		"clippy.toml",
		".oxlintrc.json",
	]) {
		expect(
			editFinding(`/repo/sub/${name}`, cfg, { mainCheckout: null })?.reason,
		).toContain("Tell the user which rule");
	}
	for (const name of ["package.json", "tsconfig.json", "pyproject.toml"])
		expect(
			editFinding(`/repo/${name}`, cfg, { mainCheckout: null }),
		).toBeNull();
});

import { editFinding } from "./edit";

test("Rust lifetimes do not hide later attributes", () => {
	expect(
		scan("a.rs", "fn f<'a>(x: &'a str) {}\n#[allow(dead_code)]", new Set([2])),
	).toMatchObject([{ line: 2 }]);
});

test("a new repo without HEAD treats staged files as all added", async () => {
	const repo = await tempRepo();
	await repo.git("checkout", "--orphan", "fresh");
	await repo.write("a.ts", "// @ts-ignore\n");
	await repo.git("add", "a.ts");
	const cfg = resolveConfig(
		{ extends: ["recommended"] },
		repo.root,
		join(repo.root, "cagr.toml"),
	);
	expect(await checkSuppressions(cfg, [join(repo.root, "a.ts")])).toMatchObject(
		[{ file: "a.ts", line: 1 }],
	);
});
