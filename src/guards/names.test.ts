import { describe, expect, test } from "bun:test";
import { config, gerb } from "../test/config";
import { branchFinding, commitMessageFinding } from "./names";

describe("branch names", () => {
	test.each(["feat/deal-pipeline", "fix/a1", "main", "HEAD"])(
		"allows %s",
		(name) => {
			expect(branchFinding(name, gerb)).toBeNull();
		},
	);

	test.each([
		"deal-pipeline",
		"feat/Deal",
		"feat/deal_pipeline",
		"feature/x",
		"feat/-x",
	])("blocks %s and names the fix", (name) => {
		const reason = branchFinding(name, gerb)?.reason ?? "";
		expect(reason).toContain(
			"<type>/<short-kebab-name>, for example feat/deal-pipeline",
		);
		expect(reason).toContain("git branch -m");
	});

	test("off without a rule", () => {
		expect(branchFinding("anything", config({}))).toBeNull();
	});

	test("a custom pattern", () => {
		const jira = config({
			git: {
				branch_name: { pattern: "^[A-Z]+-\\d+-", example: "CRM-12-deals" },
			},
		});
		expect(branchFinding("CRM-12-deals", jira)).toBeNull();
		expect(branchFinding("deals", jira)?.reason).toContain(
			"for example CRM-12-deals",
		);
	});
});

describe("commit messages", () => {
	test.each([
		"feat(deals): add pipeline board",
		"fix: handle empty list",
		"refactor(api)!: drop v1 routes",
		"# comment\nchore: bump deps\n\nbody",
		"Merge branch 'x'",
		"fixup! feat: x",
	])("allows %s", (message) => {
		expect(commitMessageFinding(message, gerb)).toBeNull();
	});

	test.each([
		"Add pipeline board",
		"feat: Add board",
		"feat: add board.",
		"feature(deals): add board",
		"feat(Deals): add board",
	])("blocks %s with an example", (message) => {
		expect(commitMessageFinding(message, gerb)?.reason).toContain(
			"Example: feat(deals): add pipeline board.",
		);
	});

	test("blocks a long subject", () => {
		expect(
			commitMessageFinding(`feat: ${"a".repeat(70)}`, gerb)?.reason,
		).toContain("76 characters");
	});

	test("commit types come from config", () => {
		const custom = config({
			git: { commit_message: "conventional", commit_types: ["feature"] },
		});
		expect(commitMessageFinding("feature: add x", custom)).toBeNull();
		expect(commitMessageFinding("feat: add x", custom)).not.toBeNull();
	});
});
