import { expect, test } from "bun:test";
import { resolveConfig } from "../config/load";
import { configuredGuards, guardIds } from "./catalog";

const config = (raw: Parameters<typeof resolveConfig>[0]) =>
	resolveConfig(raw, "/tmp/cagr-catalog-no-fragments", "cagr.toml");

test("every guard describes its configured policy and notes when off", () => {
	const active = config({
		extends: ["recommended"],
		stack: [{ language: "typescript", package_manager: "bun" }],
		git: { worktree_only: true },
		commands: { blocked: [{ match: "db push", reason: "Migrate instead." }] },
	});
	const summaries = configuredGuards(active);
	expect(summaries.map((guard) => guard.id)).toEqual(guardIds);
	for (const guard of summaries) expect(guard.summary).toBeTruthy();
	const disabled = config({
		git: {
			protected_branch: "",
			branch_name: "off",
			commit_message: "off",
			block_force_push: false,
			block_hook_skips: false,
			worktree_only: false,
		},
		review: { enabled: false, agents_may_merge: true, pr_sections: [] },
	});
	for (const guard of configuredGuards(disabled))
		expect(guard.summary).toBe(
			guard.id === "agent-approval"
				? "GitHub alias imports and aliases that bypass guards"
				: null,
		);
});

test("package manager summaries follow the allowed ecosystem managers", () => {
	const summaries = (managers: string[]) =>
		configuredGuards(
			config({
				stack: managers.map((package_manager) => ({
					language: "custom",
					package_manager,
				})),
			}),
		)[0]?.summary;
	expect(summaries(["bun", "uv"])).toBe(
		"npm, npx, pnpm, pnpx, yarn (use bun for JavaScript); pip, pip3, poetry, pipenv (use uv for Python)",
	);
	expect(summaries(["bun", "npm"])).toBe(
		"pnpm, pnpx, yarn (use bun or npm for JavaScript)",
	);
	expect(summaries(["bun", "npm", "pnpm", "yarn"])).toBeNull();
});

test("custom guard settings appear in summaries without preset assumptions", () => {
	const custom = config({
		git: {
			protected_branch: "release",
			branch_name: { pattern: "^task/", example: "task/123" },
			commit_message: { pattern: "^TASK", example: "TASK 123" },
		},
		files: { protected: [{ glob: "generated/**", reason: "Regenerate." }] },
		review: {
			enabled: true,
			gate: [],
			agents_may_merge: true,
			pr_sections: ["Checks"],
		},
	});
	const summaries = Object.fromEntries(
		configuredGuards(custom).map((guard) => [guard.id, guard.summary]),
	);
	expect(summaries["protected-branch"]).toBe("pushes to release");
	expect(summaries["protected-file"]).toBe("edits to generated/**");
	expect(summaries["branch-name"]).toContain("task/123");
	expect(summaries["commit-message"]).not.toContain("72");
	expect(summaries["review-gate"]).toBeNull();
	expect(summaries["pr-body"]).toBe("pull request body headings: Checks");
	expect(summaries["agent-approval"]).toContain("resolving review threads");
	expect(summaries["agent-approval"]).not.toContain("agent merges");
});
