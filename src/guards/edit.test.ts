import { expect, test } from "bun:test";
import { config, gerb } from "../test/config";
import { commandReasons } from "./command";
import { editFinding } from "./edit";

const noWorktrees = { mainCheckout: null };
const worktree = "/repo/.worktrees/deals";
const inWorktree = (path: string) =>
	editFinding(`${worktree}/${path}`, { ...gerb, root: worktree }, noWorktrees);

test("allows edits in a worktree and outside the repo", () => {
	expect(inWorktree("apps/web/src/lib/format.ts")).toBeNull();
	expect(inWorktree(".env.example")).toBeNull();
	expect(
		editFinding("/home/me/.claude/plans/plan.md", gerb, noWorktrees),
	).toBeNull();
	expect(editFinding("/repository/.env", gerb, noWorktrees)).toBeNull();
});

test("blocks a protected path glob", () => {
	expect(
		inWorktree(
			"packages/db/prisma/migrations/20261030000000_init/migration.sql",
		)?.reason,
	).toBe("Migrations are written by `bun run db:migrate`.");
	expect(inWorktree("packages/db/prisma/schema.prisma")).toBeNull();
});

test("blocks env files at any depth", () => {
	expect(inWorktree(".env.local")?.id).toBe("protected-file");
	expect(inWorktree("apps/web/.env")?.reason).toContain(
		"tell the user which key is missing",
	);
});

test("blocks lockfiles from the recommended preset", () => {
	expect(inWorktree("bun.lock")?.reason).toContain("package manager");
	expect(inWorktree("services/ml/uv.lock")?.id).toBe("protected-file");
});

test("no preset, nothing protected", () => {
	expect(editFinding("/repo/.env", config({}), noWorktrees)).toBeNull();
});

test("blocks edits in the main checkout when worktree_only is on", () => {
	const main = { mainCheckout: "/repo" };
	expect(
		editFinding("/repo/apps/web/src/lib/format.ts", gerb, main)?.reason,
	).toBe(commandReasons.mainCheckout(gerb).replace("Work in", "Edit in"));
	expect(editFinding(`${worktree}/a.ts`, gerb, main)).toBeNull();
	expect(editFinding("/repository/a.ts", gerb, main)).toBeNull();
});

test.each([
	"cagr.toml",
	".cagr/rules/lint.yml",
	".githooks/pre-push",
	".claude/settings.json",
	".codex/hooks.json",
	".github/workflows/ci.yml",
	".github/CODEOWNERS",
	"biome.json",
])("protects the gate file %s with the recommended preset", (path) => {
	expect(inWorktree(path)?.id).toBe("protected-file");
});

test("the configured human switch opens gate files only", () => {
	const cfg = config({
		extends: ["recommended"],
		files: { gate_edit_env: "TEST_OPEN_GATE" },
	});
	const edit = (path: string) => editFinding(`/repo/${path}`, cfg, noWorktrees);
	process.env.TEST_OPEN_GATE = "0";
	try {
		expect(edit("cagr.toml")?.id).toBe("protected-file");
		process.env.TEST_OPEN_GATE = "1";
		expect(edit("cagr.toml")).toBeNull();
		expect(edit("biome.json")).toBeNull();
		expect(edit(".env")?.id).toBe("protected-file");
		expect(edit("bun.lock")?.id).toBe("protected-file");
	} finally {
		delete process.env.TEST_OPEN_GATE;
	}
});
