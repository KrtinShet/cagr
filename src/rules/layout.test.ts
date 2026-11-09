import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../config/load";
import type { RawConfig } from "../config/presets";
import { handle } from "../hook/handlers";
import { config as testConfig } from "../test/config";
import { explainLayout, layoutFindings, stem } from "./layout";

// superagent's apps/web rules ARCH001 and ARCH002, as layout rules.
const sections = {
	layout: [
		{
			id: "arch001",
			files: ["apps/web/src/sections/**/*.{ts,tsx}"],
			ignores: ["**/*.test.*"],
			name: "^[a-z0-9]+(-[a-z0-9]+)*$",
			message: "Feature files use kebab-case names.",
			instead: "Rename the file to kebab-case, such as deal-card.tsx.",
		},
		{
			id: "arch002",
			files: [
				"apps/web/src/sections/**/view.{ts,tsx}",
				"apps/web/src/sections/**/*-view.{ts,tsx}",
			],
			allowed: ["apps/web/src/sections/*/view/*-view.tsx"],
			message: "Screens live in their feature's view folder.",
			instead: "Move it to src/sections/<feature>/view/<name>-view.tsx.",
		},
	],
};

describe("layoutFindings", () => {
	const { layout } = testConfig(sections);

	test("a name that is not kebab-case fires, tests are ignored", () => {
		const findings = layoutFindings(layout, [
			"apps/web/src/sections/deals/DealCard.tsx",
			"apps/web/src/sections/deals/deal-card.tsx",
			"apps/web/src/sections/deals/DealCard.test.tsx",
			"apps/web/src/components/Button.tsx",
		]);
		expect(findings.map((f) => [f.rule, f.path])).toEqual([
			["arch001", "apps/web/src/sections/deals/DealCard.tsx"],
		]);
		expect(findings[0]?.detail).toContain('the name "DealCard"');
	});

	test("a view outside <feature>/view/ fires, one inside does not", () => {
		const findings = layoutFindings(layout, [
			"apps/web/src/sections/deals/deals-view.tsx",
			"apps/web/src/sections/deals/view/deals-view.tsx",
			"apps/web/src/sections/deals/view/nested/deals-view.tsx",
			"apps/web/src/sections/deals/view.tsx",
		]);
		expect(findings.map((f) => f.path)).toEqual([
			"apps/web/src/sections/deals/deals-view.tsx",
			"apps/web/src/sections/deals/view/nested/deals-view.tsx",
			"apps/web/src/sections/deals/view.tsx",
		]);
		expect(findings[0]?.detail).toContain(
			"apps/web/src/sections/*/view/*-view.tsx",
		);
	});

	test("stem drops every extension and a leading dot", () => {
		expect(stem("a/user-card.test.tsx")).toBe("user-card");
		expect(stem(".env.local")).toBe("env");
	});

	test("explain prints the rule", () => {
		const config = testConfig(sections);
		const text = explainLayout(config.layout[1] as never, config);
		expect(text).toContain("arch002 (layout rule from test.toml)");
		expect(text).toContain(
			"Allowed at: apps/web/src/sections/*/view/*-view.tsx",
		);
	});
});

describe("config", () => {
	const bad = (entry: RawConfig) =>
		expect(() =>
			testConfig({
				layout: [
					{ id: "x", files: ["**"], message: "m", instead: "i", ...entry },
				],
			}),
		);

	test("a rule needs name or allowed", () => {
		bad({}).toThrow("checks nothing. Set name");
	});

	test("an invalid name pattern is an error", () => {
		bad({ name: "(" }).toThrow("not a valid regular expression");
	});

	test("an id may not be a guard id or repeat", () => {
		bad({ id: "force-push", name: "x" }).toThrow("is a built-in guard");
		expect(() =>
			testConfig({
				layout: [
					{ id: "x", files: ["**"], name: "a", message: "m", instead: "i" },
					{ id: "x", files: ["**"], name: "b", message: "m", instead: "i" },
				],
			}),
		).toThrow("two layout rules use this id");
	});

	test("message and instead are required", () => {
		expect(() =>
			testConfig({ layout: [{ id: "x", files: ["**"], name: "a" }] }),
		).toThrow("layout[0].message is required");
	});
});

describe("hooks", () => {
	async function setup() {
		const root = await realpath(await mkdtemp(join(tmpdir(), "gw-layout-")));
		const dir = join(root, "apps/web/src/sections/deals");
		await mkdir(dir, { recursive: true });
		const config = resolveConfig(sections, root, join(root, "cagr.toml"));
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
			input("file.before_edit", "apps/web/src/sections/deals/DealCard.tsx"),
			config,
		);
		expect(decision).toEqual({
			kind: "deny",
			reason:
				'Do not create apps/web/src/sections/deals/DealCard.tsx: Feature files use kebab-case names. (the name "DealCard" does not match /^[a-z0-9]+(-[a-z0-9]+)*$/.) Instead: Rename the file to kebab-case, such as deal-card.tsx. (cagr: arch001)',
		});
	});

	test("editing an existing file is allowed before, reported after", async () => {
		const { dir, config, input } = await setup();
		await writeFile(join(dir, "DealCard.tsx"), "export {};\n");
		const file = "apps/web/src/sections/deals/DealCard.tsx";
		expect(await handle(input("file.before_edit", file), config)).toEqual({
			kind: "allow",
		});
		const after = await handle(input("file.after_edit", file), config);
		expect(after.kind).toBe("block");
		expect("reason" in after && after.reason).toContain(
			`## Layout\n${file} arch001: Feature files use kebab-case names.`,
		);
	});

	test("turn.end reports a file the turn put in the wrong place", async () => {
		const { root, dir, config } = await setup();
		await mkdir(join(dir, "view"), { recursive: true });
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
			"apps/web/src/sections/deals/deals-view.tsx arch002: Screens live in their feature's view folder. (it may only live at apps/web/src/sections/*/view/*-view.tsx.)",
		);
	});

	test("a good new path is allowed", async () => {
		const { config, input } = await setup();
		expect(
			await handle(
				input(
					"file.before_edit",
					"apps/web/src/sections/deals/view/deals-view.tsx",
				),
				config,
			),
		).toEqual({ kind: "allow" });
	});
});
