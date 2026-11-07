import { expect, test } from "bun:test";
import { brief } from "./brief";
import { config, gerb } from "./test/config";

test("the brief lists what the config enforces, briefly", () => {
	const text = brief(gerb, []);
	expect(text.split("\n")).toEqual([
		"guardwright checks this repo. When it blocks something, its message says what to do instead.",
		"- Package managers: bun for JavaScript.",
		'- Git: never push to main, push a branch and open a pull request; branches look like feat/deal-pipeline; commit subjects look like "feat(deals): add pipeline board"; no force pushes; no --no-verify.',
		"- Do not edit: .env*, {bun.lock,bun.lockb,package-lock.json,pnpm-lock.yaml,yarn.lock,uv.lock,poetry.lock,Pipfile.lock,Cargo.lock,go.sum}, packages/db/prisma/migrations/**.",
		"- Do not run: `prisma db push`, `prisma migrate dev`, `prisma migrate reset`.",
	]);
});

test("stacks, rules and extra lines appear when set", () => {
	const repo = config({
		stack: [
			{
				language: "python",
				package_manager: "uv",
				paths: ["ml/**"],
				on_edit: ["ruff format {files}"],
				on_turn_end: ["pytest -q"],
			},
		],
		brief: ["Ask before adding a dependency."],
	});
	const text = brief(repo, [{ id: "no-print" } as never]);
	expect(text).toContain("- Package managers: uv for Python.");
	expect(text).toContain(
		"- python (ml/**): after each edit `ruff format {files}` run on the changed files; before you finish `pytest -q` must pass.",
	);
	expect(text).toContain(
		"- 1 code rule (no-print). `guardwright explain <id>` shows one.",
	);
	expect(text).toEndWith("- Ask before adding a dependency.");
	expect(text).not.toContain("Git:");
});
