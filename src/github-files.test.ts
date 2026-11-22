import { expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "./config/load";
import { codeowners, pullRequestTemplate, workflowYaml } from "./github-files";
import { keptNotes, sync } from "./sync";
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
	expect(yaml).toContain("- run: cagr ci");
	expect(yaml).toContain("!github.event.pull_request.draft");
	expect(yaml).toContain("- run: cagr review --ci");
	expect(yaml).toContain(
		"ANTHROPIC_API_KEY: $" + "{{ secrets.ANTHROPIC_API_KEY }}",
	);
	expect(yaml).toContain("cron: '0 3 * * *'");
	expect(yaml).toContain("cagr review --scan 'src/**' --issue");
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

test("only the review job looks for a successful status before running its steps", () => {
	const { jobs } = Bun.YAML.parse(workflowYaml(bun)) as {
		jobs: Record<
			"checks" | "review" | "nightly",
			{
				if: string;
				permissions?: Record<string, string>;
				steps: {
					id?: string;
					run?: string;
					if?: string;
					env?: Record<string, string>;
				}[];
			}
		>;
	};
	const { checks, review, nightly } = jobs;
	const [status, ...reviewSteps] = review.steps;
	expect(review.if).toBe(
		"github.event_name == 'pull_request' && !github.event.pull_request.draft",
	);
	expect(status?.id).toBe("review-status");
	expect(review.permissions?.statuses).toBe("read");
	expect(status?.run).toContain(
		'gh api "repos/$REPO/commits/$SHA/status?per_page=100" --paginate',
	);
	expect(status?.run).toContain(
		'select((.context | ascii_downcase) == "cagr/review") | .state',
	);
	expect(status?.env).toEqual({
		REPO: "$" + "{{ github.repository }}",
		SHA: "$" + "{{ github.event.pull_request.head.sha }}",
		GH_TOKEN: "$" + "{{ github.token }}",
	});
	for (const step of reviewSteps)
		expect(step.if).toBe("steps.review-status.outputs.skip != 'true'");
	expect(checks.steps).toContainEqual({ run: "cagr ci" });
	for (const job of [checks, nightly])
		expect(job.steps.some((step) => step.run?.includes("gh api"))).toBe(false);

	const scratch = mkdtempSync(join(tmpdir(), "gw-review-status-"));
	try {
		const output = join(scratch, "output");
		for (const state of ["success", "pending", "", "unavailable"]) {
			writeFileSync(output, "");
			const result = Bun.spawnSync(
				[
					"bash",
					"-ec",
					`gh() {
						if [ "$STATE" = unavailable ]; then return 1; fi
						printf '%s\\n' "$STATE"
					}
					${status?.run}`,
				],
				{
					env: {
						...process.env,
						STATE: state,
						SHA: "test-sha",
						GITHUB_OUTPUT: output,
					},
				},
			);
			expect(result.exitCode).toBe(0);
			expect(readFileSync(output, "utf8")).toBe(
				state === "success" ? "skip=true\n" : "",
			);
			if (state === "success")
				expect(result.stdout.toString()).toContain(
					"Skipping review for test-sha",
				);
			if (state === "unavailable")
				expect(result.stdout.toString()).toContain("Running review.");
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
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
		readFileSync(join(root, ".github/workflows/cagr.yml"), "utf8"),
	).toContain("cagr ci");
	expect(existsSync(join(root, ".github/pull_request_template.md"))).toBe(true);
	expect(sync(on, { check: true }).drifted).toEqual([]);
});

test("sync keeps a hand-written CODEOWNERS and PR template, and says so", () => {
	const root = mkdtempSync(join(tmpdir(), "gw-ghfiles-"));
	mkdirSync(join(root, ".github"));
	const owners = "* @org/everyone\n";
	const template = "## What\n";
	writeFileSync(join(root, ".github/CODEOWNERS"), owners);
	writeFileSync(join(root, ".github/pull_request_template.md"), template);
	const on = resolveConfig(
		{
			extends: ["recommended"],
			ci: { github: true },
			risk: { paths: [{ glob: "src/**", tier: "high", owners: ["@sec"] }] },
		},
		root,
		join(root, "g.toml"),
	);
	const result = sync(on);
	expect(result.kept.sort()).toEqual([
		".github/CODEOWNERS",
		".github/pull_request_template.md",
	]);
	expect(readFileSync(join(root, ".github/CODEOWNERS"), "utf8")).toBe(owners);
	expect(
		readFileSync(join(root, ".github/pull_request_template.md"), "utf8"),
	).toBe(template);
	expect(sync(on, { check: true }).drifted).toEqual([]);
	expect(keptNotes(result.kept)[0]).toContain("Move its owners into");
	writeFileSync(
		join(root, ".github/CODEOWNERS"),
		"# Generated by `cagr sync`. old\n",
	);
	expect(sync(on).written).toContain(".github/CODEOWNERS");
});

test("sync writes no CODEOWNERS or PR template when GitHub would read the user's from another place", () => {
	const setups: [Record<string, string>, string[]][] = [
		[{ CODEOWNERS: "* @a\n" }, ["CODEOWNERS"]],
		[{ "docs/CODEOWNERS": "* @a\n" }, ["docs/CODEOWNERS"]],
		[{ "PULL_REQUEST_TEMPLATE.md": "## What\n" }, ["PULL_REQUEST_TEMPLATE.md"]],
		[
			{ "docs/pull_request_template.md": "x\n" },
			["docs/pull_request_template.md"],
		],
		[
			{ ".github/PULL_REQUEST_TEMPLATE/feature.md": "x\n" },
			[".github/PULL_REQUEST_TEMPLATE"],
		],
	];
	for (const [files, kept] of setups) {
		const root = mkdtempSync(join(tmpdir(), "gw-ghfiles-"));
		for (const [path, text] of Object.entries(files)) {
			mkdirSync(join(root, path, ".."), { recursive: true });
			writeFileSync(join(root, path), text);
		}
		const on = resolveConfig(
			{
				extends: ["recommended"],
				ci: { github: true },
				risk: { paths: [{ glob: "src/**", tier: "high", owners: ["@sec"] }] },
			},
			root,
			join(root, "g.toml"),
		);
		const result = sync(on);
		expect(result.kept).toEqual(kept);
		const generated = kept[0]?.includes("CODEOWNERS")
			? ".github/CODEOWNERS"
			: ".github/pull_request_template.md";
		expect(existsSync(join(root, generated))).toBe(false);
		expect(sync(on, { check: true }).drifted).toEqual([]);
	}
});

test("sync deletes its own .github copy once the user keeps theirs elsewhere, and --check reports it", () => {
	const root = mkdtempSync(join(tmpdir(), "gw-ghfiles-"));
	const on = resolveConfig(
		{
			extends: ["recommended"],
			ci: { github: true },
			risk: { paths: [{ glob: "src/**", tier: "high", owners: ["@sec"] }] },
		},
		root,
		join(root, "g.toml"),
	);
	sync(on);
	expect(existsSync(join(root, ".github/CODEOWNERS"))).toBe(true);
	expect(existsSync(join(root, ".github/pull_request_template.md"))).toBe(true);
	writeFileSync(join(root, "CODEOWNERS"), "* @a\n");
	mkdirSync(join(root, "docs"));
	writeFileSync(join(root, "docs/PULL_REQUEST_TEMPLATE.md"), "## What\n");
	expect(sync(on, { check: true }).drifted.sort()).toEqual([
		".github/CODEOWNERS",
		".github/pull_request_template.md",
	]);
	const result = sync(on);
	expect(result.removed.map((entry) => entry.file).sort()).toEqual([
		".github/CODEOWNERS",
		".github/pull_request_template.md",
	]);
	expect(existsSync(join(root, ".github/CODEOWNERS"))).toBe(false);
	expect(existsSync(join(root, ".github/pull_request_template.md"))).toBe(
		false,
	);
	expect(keptNotes(result.kept, result.removed).join("\n")).toContain(
		"Deleted .github/CODEOWNERS, which `cagr sync` wrote: GitHub reads it before CODEOWNERS",
	);
	expect(sync(on, { check: true }).drifted).toEqual([]);
});

test("sync keeps a .github/PULL_REQUEST_TEMPLATE.md that differs from its own name only in case", () => {
	const root = mkdtempSync(join(tmpdir(), "gw-ghfiles-"));
	const on = resolveConfig(
		{ extends: ["recommended"], ci: { github: true } },
		root,
		join(root, "g.toml"),
	);
	mkdirSync(join(root, ".github"));
	const mine = `${pullRequestTemplate(on)}\n## Mine\n`;
	writeFileSync(join(root, ".github/PULL_REQUEST_TEMPLATE.md"), mine);
	expect(sync(on, { check: true }).drifted).not.toContain(
		".github/pull_request_template.md",
	);
	expect(sync(on).removed).toEqual([]);
	expect(
		readFileSync(join(root, ".github/PULL_REQUEST_TEMPLATE.md"), "utf8"),
	).toBe(mine);
});

test("CI checks the exact PR head with full merge-base history", () => {
	const config = resolveConfig({}, "/repo", "cagr.toml");
	const yaml = workflowYaml(config);
	expect(yaml).toContain("fetch-depth: 0");
	expect(yaml).toContain(
		"ref: $" + "{{ github.event.pull_request.head.sha || github.sha }}",
	);
});

test("every generated checkout has exactly one ref", () => {
	const yaml = workflowYaml(bun);
	const steps = yaml.split("      - uses: actions/checkout@v4").slice(1);
	expect(steps.length).toBeGreaterThan(1);
	for (const step of steps)
		expect(step.split("      - ")[0]?.match(/^ {10}ref:/gm)).toHaveLength(1);
});

test("generated native stack CI installs Go and Rust components once alongside JS", () => {
	const yaml = workflowYaml(
		config({
			stack: [
				{ language: "go" },
				{ language: "go", paths: ["service/**"] },
				{ language: "rust" },
				{ language: "rust", paths: ["crates/a/**"] },
				{ language: "typescript", package_manager: "bun" },
			],
		}),
	);
	expect(yaml.split("uses: actions/setup-go@v5")).toHaveLength(2);
	expect(yaml).toContain("go-version: stable");
	expect(yaml.split("uses: dtolnay/rust-toolchain@stable")).toHaveLength(2);
	expect(yaml).toContain("components: rustfmt, clippy");
	expect(yaml).toContain("uses: oven-sh/setup-bun@v2");
	expect(yaml.indexOf("components: rustfmt, clippy")).toBeLessThan(
		yaml.indexOf("- run: cagr ci"),
	);
	const plain = workflowYaml(
		config({ stack: [{ language: "typescript", package_manager: "bun" }] }),
	);
	expect(plain).not.toContain("setup-go");
	expect(plain).not.toContain("rust-toolchain");
});
