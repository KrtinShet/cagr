import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/load";
import type { Gh } from "../review/github";
import { run } from "../run";
import { sync } from "../sync";
import { tempRepo } from "../test/repo";
import { watchPaths } from "./cache";
import { localCi } from "./run";

async function fixture(install?: string) {
	const repo = await tempRepo();
	await repo.write(
		"cagr.toml",
		`[agents]
enabled = []
[git]
commit_message = "conventional"
[review]
pr_sections = ["Testing"]
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

function runtime(
	f: Awaited<ReturnType<typeof fixture>>,
	settings: {
		details?: Record<string, unknown>;
		permission?: string;
		heads?: { number: number; headRefOid: string; isDraft?: boolean }[];
		statuses?: Record<string, string>;
		installFails?: boolean;
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
				settings.heads ?? [{ number: 3, headRefOid: f.head }],
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
		if (args.includes(`repos/o/r/issues/3/comments`)) return "";
		const sha = args.find((arg) => arg.includes("/commits/"))?.split("/")[4];
		if (sha) return settings.statuses?.[sha] ?? "";
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

test("watch skips either existing status and drafts, and runs a new SHA once", async () => {
	const f = await fixture();
	try {
		const checks = "a".repeat(40);
		const review = "b".repeat(40);
		const r = runtime(f, {
			heads: [
				{ number: 1, headRefOid: checks },
				{ number: 2, headRefOid: review },
				{ number: 3, headRefOid: f.head },
				{ number: 4, headRefOid: f.head },
				{ number: 5, headRefOid: "c".repeat(40), isDraft: true },
			],
			statuses: {
				[checks]: "cagr/checks",
				[review]: "cagr/review",
				[f.head]: "someone/else",
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
		expect(statuses.every((args) => args.includes("state=success"))).toBe(true);
		expect(await Bun.file(f.paths.lastRun).text()).toMatch(
			/^\d{4}-\d{2}-\d{2}T/,
		);
		expect(await f.repo.git("status", "--porcelain")).toBe("");
	} finally {
		f.clean();
	}
});

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
);

test("a changed PR head is never checked out or given a status for stale metadata", async () => {
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
});

test("an install failure posts failed checks, still reviews, and cleans up both worktrees", async () => {
	const f = await fixture("custom install");
	try {
		const r = runtime(f, { installFails: true });
		expect(await localCi(f.config, f.paths, 3, r)).toBe(false);
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
});

test("watch skips a live lock and takes over after the holder dies", async () => {
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
});

test("local PR metadata uses the same title and body rules as Actions", async () => {
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
});
