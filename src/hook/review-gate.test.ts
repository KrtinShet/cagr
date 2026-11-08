import { expect, test } from "bun:test";
import { join } from "node:path";
import { resolveConfig } from "../config/load";
import { recordPath, writeRecord } from "../review/store";
import { tempRepo } from "../test/repo";
import { finding, record, round } from "../test/review";
import { handle } from "./handlers";
import type { HookInput } from "./types";

const body =
	'--body "## Testing\nbun test\n## Risk\nlow\n## How to revert\ngit revert"';

async function setup() {
	const repo = await tempRepo();
	await repo.git("checkout", "-q", "-b", "feat/x");
	const head = await repo.commit("feat: a", { "src/a.ts": "1\n" });
	const config = resolveConfig(
		{ extends: ["recommended"] },
		repo.root,
		join(repo.root, "guardwright.toml"),
	);
	const file = recordPath(join(repo.root, ".git"), "feat/x");
	const create = (command = `gh pr create -t x ${body}`): HookInput => ({
		event: "command.before",
		sessionId: "s",
		cwd: repo.root,
		command,
		files: [],
	});
	return { repo, head, config, file, create };
}

test("gh pr create is denied until the branch is reviewed", async () => {
	const { config, create } = await setup();
	const decision = await handle(create(), config);
	expect(decision.kind).toBe("deny");
	expect(decision.kind === "deny" && decision.reason).toContain(
		"has not been reviewed",
	);
});

test("an open Important finding denies, and fixing or answering it lets the PR through", async () => {
	const { head, config, file, create } = await setup();
	writeRecord(file, record([round({ head })], [finding()], "feat/x"));
	const denied = await handle(create(), config);
	expect(denied.kind === "deny" && denied.reason).toContain("f1 src/a.ts:4");
	writeRecord(
		file,
		record([round({ head })], [finding({ status: "answered" })], "feat/x"),
	);
	expect(await handle(create(), config)).toEqual({ kind: "allow" });
});

test("the body check runs before the review gate", async () => {
	const { head, config, file, create } = await setup();
	writeRecord(file, record([round({ head })], [], "feat/x"));
	const decision = await handle(create("gh pr create --fill"), config);
	expect(decision.kind === "deny" && decision.reason).toContain("--fill");
});

test("agents cannot merge, whatever the review says", async () => {
	const { head, config, file, create } = await setup();
	writeRecord(file, record([round({ head })], [], "feat/x"));
	const decision = await handle(create("gh pr merge 3 --squash"), config);
	expect(decision.kind === "deny" && decision.reason).toContain(
		"let a person review and merge it",
	);
});

test("with review off, gh pr create is not gated", async () => {
	const { repo, create } = await setup();
	const config = resolveConfig({}, repo.root, join(repo.root, "x.toml"));
	expect(await handle(create("gh pr create --fill"), config)).toEqual({
		kind: "allow",
	});
});

test("on a detached HEAD the gate denies and says how to name the branch", async () => {
	const { repo, head, config, file, create } = await setup();
	writeRecord(file, record([round({ head })], [], "feat/x"));
	await repo.git("checkout", "-q", "--detach");
	const decision = await handle(create(), config);
	expect(decision.kind === "deny" && decision.reason).toContain(
		"HEAD is detached",
	);
	expect(
		await handle(create(`gh pr create --head feat/x -t x ${body}`), config),
	).toEqual({ kind: "allow" });
});

test("--head checks that branch's review, not the one checked out", async () => {
	const { repo, head, config, file, create } = await setup();
	writeRecord(file, record([round({ head })], [], "feat/x"));
	await repo.git("checkout", "-q", "-b", "feat/b");
	await repo.commit("feat: b", { "src/b.ts": "1\n" });
	await repo.git("checkout", "-q", "feat/x");
	const other = await handle(
		create(`gh pr create --head feat/b -t x ${body}`),
		config,
	);
	expect(other.kind === "deny" && other.reason).toContain(
		"has not been reviewed",
	);
	const missing = await handle(
		create(`gh pr create --head nope -t x ${body}`),
		config,
	);
	expect(missing.kind === "deny" && missing.reason).toContain(
		"There is no local branch nope",
	);
	expect(await handle(create(), config)).toEqual({ kind: "allow" });
});

test("gh pr new and flags before the subcommand are gated too", async () => {
	const { config, create } = await setup();
	for (const command of [
		`gh pr new -t x ${body}`,
		`gh -R o/r pr create -t x ${body}`,
	]) {
		const decision = await handle(create(command), config);
		expect(decision.kind === "deny" && decision.reason).toContain(
			"has not been reviewed",
		);
	}
});
