import { expect, test } from "bun:test";
import { programsOf } from "./doctor";

test("a check needs its runner, and the tool behind an exec runner", () => {
	expect(programsOf("bun run lint")).toEqual([{ name: "bun", dirs: [] }]);
	expect(programsOf("bunx biome check --write {files}")).toEqual([
		{ name: "bunx", dirs: [] },
		{ name: "biome", dirs: ["node_modules/.bin"] },
	]);
	expect(programsOf("uv run --project services/ml ruff check {files}")).toEqual(
		[
			{ name: "uv", dirs: [] },
			{ name: "ruff", dirs: ["services/ml/.venv/bin", ".venv/bin"] },
		],
	);
	expect(programsOf("uvx ruff format {files}")).toEqual([
		{ name: "uvx", dirs: [] },
	]);
	expect(programsOf("pnpm exec eslint --fix {files}")[1]?.name).toBe("eslint");
});
