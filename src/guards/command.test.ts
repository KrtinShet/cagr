import { describe, expect, test } from "bun:test";
import { config, gerb, prisma } from "../test/config";
import { commandFinding, commandReasons, needsGitContext } from "./command";

const reasonOn =
	(branch: string, inMainCheckout = false, cfg = gerb) =>
	(line: string) =>
		commandFinding(line, cfg, { branch, inMainCheckout })?.reason ?? null;
const onFeature = reasonOn("feat/deals");
const onMain = reasonOn("main");
const reasons = {
	noVerify: commandReasons.noVerify(),
	hooksPath: commandReasons.hooksPath(),
	skipHooks: commandReasons.skipHooks(gerb),
	forcePush: commandReasons.forcePush(),
	pushAll: commandReasons.pushAll(gerb),
	pushMain: commandReasons.pushProtected(gerb),
	mainCheckout: commandReasons.mainCheckout(gerb),
	packageManager:
		"This repo uses bun for JavaScript. Use bun or bunx instead of npm, npx, pnpm, pnpx, or yarn.",
};

describe("allows normal work", () => {
	test.each([
		"git push origin maintenance-fix",
		"git push -u origin feat/deals",
		"git push origin feat/deals:feat/deals",
		"git push --dry-run origin feat/deals",
		"grep npm package.json",
		"cat yarn.lock",
		`git commit -m "chore: explain why --no-verify is blocked"`,
		`git commit -m "docs: mention CRM_SKIP_HOOKS=1"`,
		"git commit -am 'feat(deals): add board'",
		"git config core.hooksPath .githooks",
		"bun install && bunx biome check .",
		"git push -n origin feat/deals",
	])("%s", (line) => {
		expect(onFeature(line)).toBeNull();
	});
});

describe("blocks skipping hooks", () => {
	test.each([
		["git commit --no-verify -m 'x'", reasons.noVerify],
		["git commit -nm 'x'", reasons.noVerify],
		["git push --no-verify origin feat/deals", reasons.noVerify],
		["CRM_SKIP_HOOKS=1 git push", reasons.skipHooks],
		["export CRM_SKIP_HOOKS=1", reasons.skipHooks],
		["git -c core.hooksPath=/dev/null commit -m 'x'", reasons.hooksPath],
		["git config core.hooksPath /dev/null", reasons.hooksPath],
		["git config --unset core.hooksPath", reasons.hooksPath],
	])("%s", (line, reason) => {
		expect(onFeature(line)).toBe(reason);
	});

	test("the skip variable is named in the message", () => {
		expect(reasons.skipHooks).toStartWith("CRM_SKIP_HOOKS is for humans only.");
	});

	test("restoring a configured hooks folder is allowed", () => {
		const custom = config({
			extends: ["recommended"],
			git: { hooks_path: ".husky" },
		});
		const check = reasonOn("feat/x", false, custom);
		expect(check("git config core.hooksPath .husky")).toBeNull();
		expect(check("git config core.hooksPath .githooks")).toBe(
			reasons.hooksPath,
		);
	});

	test("off when block_hook_skips is false", () => {
		const loose = reasonOn(
			"feat/x",
			false,
			config({ git: { block_hook_skips: false } }),
		);
		expect(loose("git commit --no-verify -m x")).toBeNull();
		expect(loose("CAGR_SKIP=1 git push")).toBeNull();
	});
});

describe("blocks force pushes", () => {
	test.each([
		"git push --force origin feat/deals",
		"git push --force-with-lease origin feat/deals",
		"git push -f origin feat/deals",
		"git push -uf origin feat/deals",
		"git push origin +feat/deals",
	])("%s", (line) => {
		expect(onFeature(line)).toBe(reasons.forcePush);
	});

	test("off when block_force_push is false", () => {
		const loose = reasonOn(
			"feat/x",
			false,
			config({ git: { block_force_push: false } }),
		);
		expect(loose("git push --force origin feat/x")).toBeNull();
		expect(loose("git push origin +feat/x")).toBeNull();
	});
});

describe("blocks pushes to main", () => {
	test.each([
		"git push origin main",
		"git push origin HEAD:main",
		"git push origin feat/deals:refs/heads/main",
		"git push origin :main",
		"git push origin --delete main",
		"cd app && git -C .. push origin main",
	])("%s", (line) => {
		expect(onFeature(line)).toBe(reasons.pushMain);
	});

	test("a bare push while on main", () => {
		expect(onMain("git push")).toBe(reasons.pushMain);
		expect(onMain("git push origin HEAD")).toBe(reasons.pushMain);
	});

	test("a bare push from a feature branch is fine", () => {
		expect(onFeature("git push")).toBeNull();
	});

	test("every branch at once", () => {
		expect(onFeature("git push --all origin")).toBe(reasons.pushAll);
	});

	test("the protected branch comes from config", () => {
		const trunk = config({ git: { protected_branch: "trunk" } });
		expect(reasonOn("feat/x", false, trunk)("git push origin trunk")).toBe(
			commandReasons.pushProtected(trunk),
		);
		expect(reasonOn("feat/x", false, trunk)("git push origin main")).toBeNull();
	});

	test("no protected branch, no push check", () => {
		const none = reasonOn("main", false, config({}));
		expect(none("git push origin main")).toBeNull();
		expect(none("git push --all origin")).toBeNull();
	});
});

describe("blocks other package managers", () => {
	test.each([
		"npm install",
		"npx prisma migrate",
		"CI=1 pnpm i",
		"sudo yarn add x",
		"echo $(npm -v)",
	])("%s", (line) => {
		expect(onFeature(line)).toBe(reasons.packageManager);
	});
});

describe("blocks configured commands", () => {
	test.each([
		"bunx prisma db push",
		"cd packages/db && bunx prisma migrate dev --name x",
		"bun x prisma migrate reset --force",
	])("%s", (line) => {
		expect(onFeature(line)).toBe(prisma);
	});

	test("allows the repo's own commands", () => {
		expect(onFeature("bun run db:migrate --name add_x")).toBeNull();
		expect(onFeature("bunx prisma migrate status")).toBeNull();
	});

	test("the words must be next to each other", () => {
		expect(onFeature("bunx prisma db seed && git push")).toBeNull();
		expect(onFeature("echo prisma; echo db push")).toBeNull();
	});
});

describe("keeps the main checkout on main", () => {
	const inMain = reasonOn("main", true);

	test.each([
		"git checkout -b feat/deals",
		"git switch feat/deals",
		"git commit -m 'feat: x'",
		"git stash",
		"git reset --hard origin/main",
	])("%s", (line) => {
		expect(inMain(line)).toBe(reasons.mainCheckout);
	});

	test.each([
		"git status",
		"git fetch",
		"git pull --ff-only",
		"git log --oneline -5",
		"git worktree add .worktrees/deals feat/deals",
		"cd .worktrees/deals && git commit -m 'feat: x'",
		"git -C .worktrees/deals switch feat/deals",
	])("allows %s", (line) => {
		expect(inMain(line)).toBeNull();
	});

	test("a worktree may switch and commit", () => {
		expect(onFeature("git switch -c feat/other")).toBeNull();
	});
});

describe("reads heredoc bodies as text", () => {
	test("a body that mentions blocked commands is allowed", () => {
		const line =
			"cat > notes.md <<'EOF'\nnpm install\nbunx prisma db push\nEOF\ngit status";
		expect(onFeature(line)).toBeNull();
	});

	test("a command after the body is still checked", () => {
		expect(onFeature("cat <<EOF\nhello\nEOF\nnpm install")).toBe(
			reasons.packageManager,
		);
	});

	test("a here-string is not a heredoc", () => {
		expect(onFeature("cat <<< word\nnpm install")).toBe(reasons.packageManager);
	});
});

test("names the guard that fired", () => {
	expect(
		commandFinding("git push -f", gerb, { branch: "x", inMainCheckout: false })
			?.id,
	).toBe("force-push");
});

test("needsGitContext only for git commands", () => {
	expect(needsGitContext("cd a && git push")).toBe(true);
	expect(needsGitContext("npm install && echo git")).toBe(false);
});

test("git and cd run by full path or as .exe are guarded the same", () => {
	expect(onFeature("/usr/bin/git push --force origin feat/deals")).toBe(
		reasons.forcePush,
	);
	expect(onFeature("git.exe commit -n -m x")).toBe(reasons.noVerify);
	expect(onMain("/opt/homebrew/bin/git push origin main")).toBe(
		reasons.pushMain,
	);
	expect(needsGitContext("C:/Git/bin/git.exe push")).toBe(true);
	const inMain = reasonOn("main", true);
	expect(inMain("/usr/bin/git commit -m x")).toBe(reasons.mainCheckout);
	expect(inMain("/usr/bin/cd ../wt && git commit -m x")).toBeNull();
});

describe("redirections", () => {
	test("an escaped > is an argument, so a flag after it is still seen", () => {
		expect(onFeature("git commit -m \\> --no-verify")).toBe(reasons.noVerify);
		expect(onFeature("git push -f>log")).toBe(reasons.forcePush);
	});

	test("a blocked entry with a redirection matches it, however it is spaced", () => {
		const cfg = config({
			commands: {
				blocked: [
					{ match: "> .env", reason: "env" },
					{ match: "psql < prod.sql", reason: "prod" },
					{ match: "npm publish", reason: "publish" },
				],
			},
		});
		const reason = (line: string) =>
			commandFinding(line, cfg, { branch: "feat/x", inMainCheckout: false })
				?.reason ?? null;
		expect(reason("echo A=1 > .env")).toBe("env");
		expect(reason("echo A=1 >.env")).toBe("env");
		expect(reason("psql < prod.sql")).toBe("prod");
		expect(reason("psql -c 'select 1'")).toBeNull();
		expect(reason("echo A=1 > .env.example")).toBeNull();
		expect(reason("npm 2>&1 publish")).toBe("publish");
		expect(reason("npm >/dev/null publish --tag x")).toBe("publish");
	});
});
