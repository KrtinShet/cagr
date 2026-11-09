import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "./config/load";
import { commitMsg, parsePushLines, prePush } from "./git-hooks";
import { run } from "./run";
import { config } from "./test/config";

const recommended = config({ extends: ["recommended"] });
const zero = "0".repeat(40);

describe("commit-msg", () => {
	const message = async (text: string) => {
		const file = join(await mkdtemp(join(tmpdir(), "gw-msg-")), "MSG");
		await writeFile(file, text);
		return file;
	};

	test("blocks a subject that is not conventional", async () => {
		const result = commitMsg(await message("Fixed stuff\n"), recommended, {});
		expect(result.ok).toBe(false);
		expect(result.messages[0]).toContain(
			'Commit subject "Fixed stuff" does not match <type>(<scope>): <summary>',
		);
	});

	test("allows a good subject below git's comment lines", async () => {
		expect(
			commitMsg(
				await message("# comment\nfeat(cli): add doctor\n\nbody"),
				recommended,
				{},
			).ok,
		).toBe(true);
	});

	test("a human can skip with the skip variable", async () => {
		expect(
			commitMsg(await message("bad"), recommended, { CAGR_SKIP: "1" }).ok,
		).toBe(true);
		expect(
			commitMsg(await message("bad"), recommended, { CAGR_SKIP: "0" }).ok,
		).toBe(false);
	});
});

test("parsePushLines reads git's pre-push stdin", () => {
	expect(parsePushLines(`refs/heads/a 111 refs/heads/a ${zero}\n\n`)).toEqual([
		{
			localRef: "refs/heads/a",
			localSha: "111",
			remoteRef: "refs/heads/a",
			remoteSha: zero,
		},
	]);
});

describe("pre-push", () => {
	let root: string;
	let first: string;
	let second: string;
	const git = async (...args: string[]) =>
		(await run(["git", ...args], root)).output.trim();

	beforeAll(async () => {
		root = await realpath(await mkdtemp(join(tmpdir(), "gw-push-")));
		await git("init", "-q", "-b", "main");
		await git(
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@t",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"one",
		);
		first = await git("rev-parse", "HEAD");
		await git(
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@t",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"two",
		);
		second = await git("rev-parse", "HEAD");
	});
	const repo = (raw = {}) =>
		resolveConfig({ extends: ["recommended"], ...raw }, root, "x");
	const line = (branch: string, local: string, remote = zero) =>
		`refs/heads/${branch} ${local} refs/heads/${branch} ${remote}\n`;

	test("blocks a push to the protected branch", async () => {
		const result = await prePush(line("main", second), repo(), root, {});
		expect(result.messages).toEqual([
			expect.stringMatching(
				/^Do not push to main\..*\(cagr: protected-branch\)$/,
			),
		]);
	});

	test("blocks a branch with a bad name and allows a good one", async () => {
		expect(
			(await prePush(line("my-stuff", second), repo(), root, {})).messages[0],
		).toContain('Branch "my-stuff" does not match');
		expect(
			(await prePush(line("feat/doctor", second, first), repo(), root, {})).ok,
		).toBe(true);
	});

	test("blocks a push that would drop remote commits", async () => {
		const result = await prePush(
			line("feat/doctor", first, second),
			repo(),
			root,
			{},
		);
		expect(result.messages).toEqual([
			expect.stringContaining("(cagr: force-push)"),
		]);
		expect(
			(
				await prePush(
					line("feat/doctor", first, second),
					repo({ git: { block_force_push: false } }),
					root,
					{},
				)
			).ok,
		).toBe(true);
	});

	test("a remote commit this clone has not fetched is left to the server", async () => {
		expect(
			(
				await prePush(
					line("feat/doctor", second, "a".repeat(40)),
					repo(),
					root,
					{},
				)
			).ok,
		).toBe(true);
	});

	test("deleting a branch skips the checks", async () => {
		expect(
			(await prePush(line("whatever", zero, first), repo(), root, {})).ok,
		).toBe(true);
	});

	test("runs pre_push commands after the checks and stops on failure", async () => {
		const result = await prePush(
			line("feat/doctor", second),
			repo({ git: { pre_push: ["echo checking", "echo broke >&2; exit 3"] } }),
			root,
			{},
		);
		expect(result).toEqual({
			ok: false,
			messages: [
				"`echo broke >&2; exit 3` failed, so the push was stopped.\nbroke",
			],
		});
	});

	test("[review] status starts post-status in the background, --checks only for a clean HEAD", async () => {
		const started: string[][] = [];
		const start = (args: string[]) => {
			started.push(args);
		};
		const status = repo({
			git: { pre_push: ["true"] },
			review: { status: true },
		});
		const push = `${line("feat/doctor", second)}${line("feat/older", first)}`;
		const result = await prePush(push, status, root, {}, start);
		expect(result.ok).toBe(true);
		expect(result.messages[0]).toContain(
			"sending the GitHub commit statuses once the push lands",
		);
		expect(started).toEqual([
			[
				"post-status",
				second,
				"--branch",
				"feat/doctor",
				"--wait",
				"120",
				"--checks",
			],
			["post-status", first, "--branch", "feat/older", "--wait", "120"],
		]);
		started.length = 0;
		await prePush(line("feat/doctor", second), repo(), root, {}, start);
		await prePush(
			line("feat/doctor", second),
			repo({ git: { pre_push: ["exit 1"] }, review: { status: true } }),
			root,
			{},
			start,
		);
		expect(started).toEqual([]);
	});

	test("[review] status without pre_push commands sends only cagr/review", async () => {
		const started: string[][] = [];
		await prePush(
			line("feat/doctor", second),
			repo({ review: { status: true } }),
			root,
			{},
			(args) => {
				started.push(args);
			},
		);
		expect(started).toEqual([
			["post-status", second, "--branch", "feat/doctor", "--wait", "120"],
		]);
	});

	test("the skip variable skips everything", async () => {
		expect(
			(
				await prePush(line("main", second), repo(), root, {
					CAGR_SKIP: "1",
				})
			).ok,
		).toBe(true);
	});
});
