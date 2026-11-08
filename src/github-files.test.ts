import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "./config/load";
import { codeowners, pullRequestTemplate, workflowYaml } from "./github-files";
import { sync } from "./sync";
import { config } from "./test/config";

const bun = config({
	extends: ["recommended"],
	stack: [{ language: "typescript", package_manager: "bun" }],
	ci: { github: true, review: true, nightly: ["src/**"] },
});

test("the workflow runs the checks, reviews non-draft PRs, and scans nightly", () => {
	const yaml = workflowYaml(bun);
	expect(yaml).toContain("uses: oven-sh/setup-bun@v2");
	expect(yaml).toContain("bun install --frozen-lockfile");
	expect(yaml).toContain("- run: guardwright ci");
	expect(yaml).toContain("!github.event.pull_request.draft");
	expect(yaml).toContain("- run: guardwright review --ci");
	expect(yaml).toContain(
		"ANTHROPIC_API_KEY: $" + "{{ secrets.ANTHROPIC_API_KEY }}",
	);
	expect(yaml).toContain("cron: '0 3 * * *'");
	expect(yaml).toContain("guardwright review --scan 'src/**' --issue");
	const plain = workflowYaml(
		config({
			stack: [{ language: "python", package_manager: "uv" }],
			ci: { github: true },
		}),
	);
	expect(plain).toContain("astral-sh/setup-uv@v6");
	expect(plain).not.toContain("review --ci");
	expect(plain).not.toContain("schedule:");
});

test("the template has a heading per section, and CODEOWNERS comes from [risk] owners", () => {
	const template = pullRequestTemplate(bun);
	for (const heading of [
		"## Summary",
		"## Testing",
		"## Risk",
		"## How to revert",
	])
		expect(template).toContain(heading);
	expect(codeowners(bun)).toBeNull();
	const owned = config({
		risk: {
			paths: [
				{ glob: "src/auth/**", tier: "high", owners: ["@org/sec"] },
				{ glob: "*.sql", tier: "high", owners: ["@dba"] },
			],
		},
	});
	expect(codeowners(owned)).toContain("/src/auth/** @org/sec\n*.sql @dba\n");
});

test("sync writes the GitHub files only when ci.github is on", () => {
	const root = mkdtempSync(join(tmpdir(), "gw-ghfiles-"));
	const off = resolveConfig(
		{ extends: ["recommended"] },
		root,
		join(root, "g.toml"),
	);
	sync(off);
	expect(existsSync(join(root, ".github"))).toBe(false);
	const on = resolveConfig(
		{ extends: ["recommended"], ci: { github: true } },
		root,
		join(root, "g.toml"),
	);
	sync(on);
	expect(
		readFileSync(join(root, ".github/workflows/guardwright.yml"), "utf8"),
	).toContain("guardwright ci");
	expect(existsSync(join(root, ".github/pull_request_template.md"))).toBe(true);
	expect(sync(on, { check: true }).drifted).toEqual([]);
});
