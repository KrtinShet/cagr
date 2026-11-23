import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/load";
import { encodeState, type Gh } from "../review/github";
import { recordPath, writeRecord } from "../review/store";
import { run } from "../run";
import { sync } from "../sync";
import { repoTestTimeout } from "../test/budgets";
import { tempRepo } from "../test/repo";
import { finding, record, round } from "../test/review";
import { watchPaths } from "./cache";
import { localCi } from "./run";

async function fixture({
	install,
	prePush,
	maxRounds,
}: {
	install?: string;
	prePush?: string;
	maxRounds?: number;
} = {}) {
	const repo = await tempRepo();
	await repo.write(
		"cagr.toml",
		`[agents]
enabled = []
[admission]
enabled = false
[git]
commit_message = "conventional"
${prePush ? `pre_push = ${JSON.stringify(prePush)}` : ""}
[review]
pr_sections = ["Testing"]
${maxRounds === undefined ? "" : `enabled = true\nmax_rounds = ${maxRounds}`}
[ci]
local = true
${install ? `install = ${JSON.stringify(install)}` : ""}
[[stack]]
language = "typescript"
package_manager = "bun"
paths = ["**"]
`,
	);
	const config = loadConfig(repo.root);
	if (!config) throw new Error("Test config is missing");
	sync(config);
	await repo.commit("chore: add config", {});
	const home = mkdtempSync(join(tmpdir(), "gw-watch-"));
	const paths = await watchPaths(repo.root, home, join(home, ".config"));
	if (!paths) throw new Error("Test repo is missing");
	const source = await tempRepo();
	await source.git("fetch", repo.root, "main");
	await source.git("checkout", "-B", "target", "FETCH_HEAD");
	const base = await source.git("rev-parse", "HEAD");
	const head = await source.commit("feat: update README", {
		"README.md": "update\n",
	});
	await source.git("update-ref", "refs/heads/target", base);
	await source.git("update-ref", "refs/pull/3/head", head);
	return {
		repo,
		paths,
		config,
		source,
		base,
		head,
		clean() {
			rmSync(home, { recursive: true, force: true });
			rmSync(source.root, { recursive: true, force: true });
			rmSync(repo.root, { recursive: true, force: true });
		},
	};
}

const noFindings = JSON.stringify({
	type: "result",
	structured_output: { summary: "Looks good.", findings: [], fixed: [] },
});

const failingVerify =
	'test -n "$PATH" && test -n "$HOME" && git rev-parse --verify origin/target && exit 17';

function runtime(
	f: Awaited<ReturnType<typeof fixture>>,
	settings: {
		details?: Record<string, unknown>;
		permission?: string;
		heads?: { number: number; headRefOid: string; isDraft?: boolean }[];
		statuses?: Record<string, [context: string, state: string][]>;
		installFails?: boolean;
		reviewState?: string;
	} = {},
) {
	const log: string[] = [];
	const calls: string[][] = [];
	const commands: string[][] = [];
	const reviewBodies: Record<string, unknown>[] = [];
	const gh: Gh = async (args, stdin) => {
		calls.push(args);
		const [command, sub, resource] = args;
		if (command === "repo" && sub === "view")
			return JSON.stringify({
				nameWithOwner: "o/r",
				url: "https://github.com/o/r",
			});
		if (command === "pr" && sub === "list")
			return JSON.stringify(
				(settings.heads ?? [{ number: 3, headRefOid: f.head }]).map((pr) => ({
					...pr,
					headRefName: "feat/example",
				})),
			);
		if (command === "pr" && sub === "view") {
			if (resource !== "3") throw new Error(`Unexpected PR view ${resource}`);
			return JSON.stringify({
				number: 3,
				state: "OPEN",
				isDraft: false,
				isCrossRepository: false,
				author: { login: "writer" },
				headRepository: { name: "r" },
				headRepositoryOwner: { login: "o" },
				headRefName: "feat/example",
				headRefOid: f.head,
				baseRefName: "target",
				body: "## Testing\nPassed.",
				title: "feat: update README",
				...settings.details,
			});
		}
		if (args.includes("repos/o/r/collaborators/writer/permission"))
			return settings.permission ?? "write";
		if (args.includes("user")) return "owner";
		if (args.includes("graphql")) return "{}";
		if (args.includes("repos/o/r/pulls?per_page=100")) return "3";
		if (args.includes("repos/o/r/collaborators/owner/permission"))
			return "admin";
		if (args.includes("POST") && args.includes("repos/o/r/issues/3/comments"))
			return "{}";
		if (args.some((arg) => /^repos\/o\/r\/issues\/\d+\/comments$/.test(arg)))
			return settings.reviewState
				? JSON.stringify({ id: 42, login: "owner", body: settings.reviewState })
				: "";
		if (args.includes("repos/o/r/issues/comments/42")) return "{}";
		const sha = args.find((arg) => arg.includes("/commits/"))?.split("/")[4];
		if (sha) {
			const rows = settings.statuses?.[sha] ?? [];
			if (args.includes(".[] | [(.context | ascii_downcase), .state] | @tsv"))
				return rows
					.map(([context, state]) => `${context.toLowerCase()}\t${state}`)
					.join("\n");
		}
		if (
			args.includes("-X") &&
			args.some((arg) => arg.startsWith("repos/o/r/statuses/"))
		)
			return "{}";
		if (args.includes("-X") && args.includes("repos/o/r/pulls/3/reviews")) {
			reviewBodies.push(JSON.parse(stdin ?? "{}"));
			return "{}";
		}
		throw new Error(`Unexpected gh command: ${args.join(" ")}`);
	};
	const execute: typeof run = async (argv, cwd, options) => {
		commands.push(argv);
		if (argv[0] === "git") {
			if (argv.includes("fetch"))
				return run(
					argv.map((arg) => (arg === "origin" ? f.source.root : arg)),
					cwd,
					options,
				);
			return run(argv, cwd, options);
		}
		if (argv[0] === "claude") return result(true, noFindings);
		if (argv[2] === failingVerify) return run(argv, cwd, options);
		if (argv[0] === "sh")
			return result(!settings.installFails, "install output");
		throw new Error(`Unexpected command: ${argv.join(" ")}`);
	};
	return {
		gh,
		run: execute,
		log: (line: string) => log.push(line),
		lines: log,
		calls,
		commands,
		reviewBodies,
	};
}

const result = (ok: boolean, stdout: string) => ({
	ok,
	stdout,
	output: stdout,
	ms: 0,
	timedOut: false,
});

// Clones the PR cache, then fetches and creates both Git worktrees.
test(
	"watch skips both successful statuses and drafts, and runs a new SHA once",
	async () => {
		const f = await fixture();
		try {
			const complete = "a".repeat(40);
			const r = runtime(f, {
				heads: [
					{ number: 1, headRefOid: complete },
					{ number: 3, headRefOid: f.head },
					{ number: 4, headRefOid: f.head },
					{ number: 5, headRefOid: "c".repeat(40), isDraft: true },
				],
				statuses: {
					[complete]: [
						["cagr/checks", "success"],
						["cagr/review", "success"],
						["cagr/review", "failure"],
					],
					[f.head]: [["someone/else", "success"]],
				},
			});
			expect(await localCi(f.config, f.paths, "watch", r)).toBe(true);
			expect(
				r.calls
					.filter((args) => args[1] === "view" && args[0] === "pr")
					.map((args) => args[2]),
			).toEqual(["3"]);
			expect(r.commands).toContainEqual([
				"sh",
				"-c",
				"bun install --frozen-lockfile",
			]);
			expect(r.reviewBodies[0]?.commit_id).toBe(f.head);
			const statuses = r.calls.filter((args) =>
				args.includes(`repos/o/r/statuses/${f.head}`),
			);
			expect(
				statuses.map((args) => args.find((arg) => arg.startsWith("context="))),
			).toEqual(["context=cagr/checks", "context=cagr/review"]);
			expect(statuses.every((args) => args.includes("state=success"))).toBe(
				true,
			);
			expect(await Bun.file(f.paths.lastRun).text()).toMatch(
				/^\d{4}-\d{2}-\d{2}T/,
			);
			expect(await f.repo.git("status", "--porcelain")).toBe("");
		} finally {
			f.clean();
		}
	},
	repoTestTimeout,
);

test(
	"local CI posts the coverage gap on a successful capped review",
	async () => {
		const f = await fixture();
		try {
			const state = record([
				round({ head: f.base }),
				round({ n: 2, head: f.base, scope: "diff" }),
				round({ n: 3, head: f.base, scope: "verify" }),
			]);
			state.base = "target";
			const r = runtime(f, {
				reviewState: encodeState(state),
				statuses: { [f.head]: [["cagr/checks", "success"]] },
			});
			expect(await localCi(f.config, f.paths, "watch", r)).toBe(true);
			expect(r.commands.some((args) => args[0] === "claude")).toBe(false);
			expect(
				r.calls.find((args) => args.includes("context=cagr/review")),
			).toEqual(
				expect.arrayContaining([
					"state=success",
					"description=Reviewed through round 3 (cap 3); 1 later commit was not reviewed.",
				]),
			);
		} finally {
			f.clean();
		}
	},
	repoTestTimeout,
);

test(
	"watch judges CI findings even after both statuses succeed",
	async () => {
		const f = await fixture();
		try {
			const r = runtime(f, {
				reviewState: encodeState(
					record([round({ head: f.head })], [finding()]),
				),
				statuses: {
					[f.head]: [
						["cagr/checks", "success"],
						["cagr/review", "success"],
					],
				},
			});
			expect(await localCi(f.config, f.paths, "watch", r)).toBe(false);
			expect(r.commands.some((args) => args[0] === "claude")).toBe(false);
			expect(
				r.calls.find((args) => args.includes("context=cagr/review")),
			).toContain("state=failure");
			expect(
				r.calls.find((args) => args.includes("context=cagr/checks")),
			).toBeUndefined();
		} finally {
			f.clean();
		}
	},
	repoTestTimeout,
);

test(
	"explicit local CI counts the source checkout's branch record",
	async () => {
		const f = await fixture();
		try {
			writeRecord(
				recordPath(join(f.repo.root, ".git"), "feat/example"),
				record(
					[
						round({ head: f.base }),
						round({ n: 2, head: f.base }),
						round({ n: 3, head: f.base }),
					],
					[],
					"feat/example",
				),
			);
			const r = runtime(f);
			expect(await localCi(f.config, f.paths, 3, r)).toBe(true);
			expect(r.commands.some((args) => args[0] === "claude")).toBe(false);
			expect(r.lines.join("\n")).toContain(
				"CI is judging the gate from existing findings",
			);
		} finally {
			f.clean();
		}
	},
	repoTestTimeout,
);

test(
	"local review refuses a finder round after local CI used the branch cap",
	async () => {
		const f = await fixture({ maxRounds: 1 });
		try {
			const r = runtime(f);
			expect(await localCi(f.config, f.paths, 3, r)).toBe(true);
			expect(r.reviewBodies).toHaveLength(1);
			await f.repo.git("fetch", f.source.root, "refs/pull/3/head");
			await f.repo.git("checkout", "-qb", "feat/example", "FETCH_HEAD");
			const review = Bun.spawnSync(
				[process.execPath, join(import.meta.dir, "../cli.ts"), "review"],
				{
					cwd: f.repo.root,
					env: {
						...process.env,
						PATH: "/usr/bin:/bin",
						CAGR_ALLOW_EXTRA_REVIEW: "",
					},
				},
			);
			expect(review.stdout.toString()).toContain(
				"Review is capped at 1 round for this branch.",
			);
			expect(review.exitCode).toBe(2);
		} finally {
			f.clean();
		}
	},
	repoTestTimeout,
);

// Every case fetches the PR and creates a detached Git worktree.
test.each<{
	name: string;
	statuses: [string, string][];
	checks: boolean;
	review: boolean;
	listedStatuses?: [string, string][];
}>([
	{
		name: "reviews a head left pending by pre-push",
		statuses: [
			["cagr/checks", "success"],
			["cagr/review", "pending"],
		],
		checks: false,
		review: true,
	},
	{
		name: "retries a failed review after an older success",
		statuses: [
			["cagr/checks", "success"],
			["CAGR/Review", "failure"],
			["cagr/review", "success"],
		],
		checks: false,
		review: true,
	},
	{
		name: "runs pending checks with a successful review",
		statuses: [
			["cagr/checks", "pending"],
			["cagr/review", "success"],
		],
		checks: true,
		review: false,
	},
	{
		name: "retries checks with an error after an older success",
		statuses: [
			["cagr/checks", "error"],
			["cagr/checks", "success"],
			["cagr/review", "success"],
		],
		checks: true,
		review: false,
	},
	{
		name: "uses the current head's statuses when the listed head has changed",
		listedStatuses: [
			["cagr/checks", "success"],
			["cagr/review", "pending"],
		],
		statuses: [
			["cagr/checks", "pending"],
			["cagr/review", "success"],
		],
		checks: true,
		review: false,
	},
])(
	"watch $name and only posts the status it ran",
	async (row) => {
		const f = await fixture();
		try {
			const listedHead = row.listedStatuses ? "a".repeat(40) : f.head;
			const r = runtime(f, {
				heads: [{ number: 3, headRefOid: listedHead }],
				statuses: {
					[listedHead]: row.listedStatuses ?? [],
					[f.head]: row.statuses,
				},
			});
			expect(await localCi(f.config, f.paths, "watch", r)).toBe(true);
			expect(
				r.commands.some((args) => args[2] === "bun install --frozen-lockfile"),
			).toBe(row.checks);
			expect(r.commands.some((args) => args[0] === "claude")).toBe(row.review);
			const posts = r.calls.filter((args) =>
				args.includes(`repos/o/r/statuses/${f.head}`),
			);
			expect(posts).toHaveLength(1);
			expect(posts[0]).toContain(
				row.checks ? "context=cagr/checks" : "context=cagr/review",
			);
			expect(posts[0]).toContain("state=success");
		} finally {
			f.clean();
		}
	},
	repoTestTimeout,
);

// Both cases create and fetch the Git source before rejecting the PR.
test.each([
	{
		name: "fork",
		details: { isCrossRepository: true },
		message: "Head is from another repository",
	},
	{ name: "non-writer", permission: "read", message: "lacks write access" },
])(
	"refuses a $name before running commands or posting statuses",
	async (settings) => {
		const f = await fixture();
		try {
			const r = runtime(f, settings);
			expect(await localCi(f.config, f.paths, 3, r)).toBe(false);
			expect(r.lines.join("\n")).toContain(settings.message);
			expect(r.commands).toEqual([]);
			expect(r.calls.some((args) => args.includes("POST"))).toBe(false);
		} finally {
			f.clean();
		}
	},
	repoTestTimeout,
);

// Initializes the repository cache and fetches before detecting the head mismatch.
test(
	"a changed PR head is never checked out or given a status for stale metadata",
	async () => {
		const f = await fixture();
		try {
			const r = runtime(f, { details: { headRefOid: "a".repeat(40) } });
			expect(await localCi(f.config, f.paths, 3, r)).toBe(false);
			expect(r.lines.join("\n")).toContain("changed before checkout");
			expect(r.commands.some((args) => args.includes("worktree"))).toBe(false);
			expect(r.calls.some((args) => args.includes("POST"))).toBe(false);
			expect(
				readdirSync(f.paths.cache).filter((name) => name.startsWith("pr-")),
			).toEqual([]);
		} finally {
			f.clean();
		}
	},
	repoTestTimeout,
);

// Creates and removes separate Git worktrees for checks and review.
test(
	"an install failure posts failed checks, still reviews, and cleans up both worktrees",
	async () => {
		const f = await fixture({ install: "custom install" });
		try {
			const r = runtime(f, {
				installFails: true,
				statuses: {
					[f.head]: [
						["cagr/checks", "success"],
						["cagr/review", "success"],
					],
				},
			});
			expect(await localCi(f.config, f.paths, 3, r)).toBe(false);
			expect(
				r.calls.some((args) => args.some((arg) => arg.includes("/commits/"))),
			).toBe(false);
			expect(r.commands).toContainEqual(["sh", "-c", "custom install"]);
			expect(r.reviewBodies[0]?.commit_id).toBe(f.head);
			const statuses = r.calls.filter((args) =>
				args.includes(`repos/o/r/statuses/${f.head}`),
			);
			expect(statuses[0]).toContain("context=cagr/checks");
			expect(statuses[0]).toContain("state=failure");
			expect(statuses[1]).toContain("context=cagr/review");
			expect(statuses[1]).toContain("state=success");
			expect(
				readdirSync(f.paths.cache).filter((name) => name.startsWith("pr-")),
			).toEqual([]);
		} finally {
			f.clean();
		}
	},
	repoTestTimeout,
);

// Runs committed CI from a fresh Git worktree and resolves its base ref.
test(
	"a failing Verify command sees the PR base and posts failed checks",
	async () => {
		const f = await fixture({ prePush: failingVerify });
		try {
			const r = runtime(f);
			expect(await localCi(f.config, f.paths, 3, r)).toBe(false);
			expect(r.lines.join("\n")).toContain(
				`FAIL Verify\n  ${failingVerify}\n  ${f.base}`,
			);
			expect(
				r.calls.find((args) => args.includes("context=cagr/checks")),
			).toContain("state=failure");
		} finally {
			f.clean();
		}
	},
	repoTestTimeout,
);

// Builds two Git repos before starting and replacing a real lock holder.
test(
	"watch skips a live lock and takes over after the holder dies",
	async () => {
		const f = await fixture();
		const cacheModule = join(import.meta.dir, "cache.ts");
		const holder = Bun.spawn(
			[
				process.execPath,
				"-e",
				`
		const { lockWatch } = await import(${JSON.stringify(cacheModule)});
		const lock = lockWatch(${JSON.stringify(f.paths.cache)});
		if (!lock) process.exit(1);
		console.log("locked");
		setInterval(() => {}, 1000);
	`,
			],
			{ stdout: "pipe" },
		);
		try {
			const reader = holder.stdout.getReader();
			const ready = await reader.read();
			reader.releaseLock();
			expect(new TextDecoder().decode(ready.value).trim()).toBe("locked");
			const r = runtime(f, { heads: [] });
			expect(await localCi(f.config, f.paths, "watch", r)).toBe(true);
			expect(r.calls).toEqual([]);
			expect(await Bun.file(f.paths.lastRun).exists()).toBe(false);
			holder.kill("SIGKILL");
			await holder.exited;
			expect(await localCi(f.config, f.paths, "watch", r)).toBe(true);
			expect(r.calls.some((args) => args.includes("list"))).toBe(true);
			expect(await Bun.file(f.paths.lastRun).exists()).toBe(true);
		} finally {
			holder.kill();
			await holder.exited;
			f.clean();
		}
	},
	repoTestTimeout,
);

// Runs committed CI and review from separate Git worktrees.
test(
	"local PR metadata uses the same title and body rules as Actions",
	async () => {
		const f = await fixture();
		try {
			const r = runtime(f, { details: { title: "Update README", body: "" } });
			expect(await localCi(f.config, f.paths, 3, r)).toBe(false);
			expect(r.lines.join("\n")).toContain("FAIL Pull request title");
			expect(r.lines.join("\n")).toContain("FAIL Pull request body");
			expect(
				r.calls.find((args) => args.includes("context=cagr/checks")),
			).toContain("state=failure");
		} finally {
			f.clean();
		}
	},
	repoTestTimeout,
);
