import { afterEach, test as bunTest, expect } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type RunOptions, run, shellQuote } from "../run";
import { tempRepo } from "../test/repo";
import { holder, LeaseRefs } from "./refs";

const cli = resolve(import.meta.dir, "../cli.ts");
const name = "db-migrations";
const leaseRef = `refs/cagr/lease/${name}`;
const waitPrefix = `refs/cagr/wait/${name}/`;
let cleanup: string[] = [];
const test = (name: string, fn: () => Promise<void>) =>
	bunTest(name, fn, 90_000);

afterEach(async () => {
	for (const dir of cleanup) await rm(dir, { recursive: true, force: true });
	cleanup = [];
});

async function git(cwd: string, ...args: string[]) {
	const result = await run(["git", ...args], cwd);
	if (!result.ok) throw new Error(result.output);
	return result.stdout.trim();
}

async function fixture(ttl = 1800) {
	const parent = await mkdtemp(join(tmpdir(), "cagr-lease-"));
	const repo = await tempRepo("cagr-lease-seed-");
	cleanup.push(parent, repo.root);
	const origin = join(parent, "origin.git");
	const config = (prePush: string, branchName = "off") =>
		`[agents]\nenabled = []\ncommand = ${JSON.stringify([process.execPath, cli].map(shellQuote).join(" "))}\n[git]\nprotected_branch = "main"\nbranch_name = "${branchName}"\nblock_force_push = true\npre_push = ${JSON.stringify(prePush)}\n`;
	await repo.commit("chore: set up serial migrations", {
		"cagr.toml": config("true"),
		".cagr/serial.toml": `[[lease]]\nname = "${name}"\npaths = ["migrations/**"]\nafter_acquire = "Merge main and regenerate."\nttl_seconds = ${ttl}\n`,
		"migrations/0001.sql": "initial\n",
	});
	const synced = await run([process.execPath, cli, "sync"], repo.root);
	if (!synced.ok) throw new Error(synced.output);
	await repo.commit("chore: commit generated hooks", {});
	await git(parent, "clone", "-q", "--bare", repo.root, origin);
	const builder = async (branch: string) => {
		const cwd = join(parent, branch);
		await git(parent, "clone", "-q", origin, cwd);
		await git(cwd, "config", "user.name", "Builder");
		await git(cwd, "config", "user.email", "builder@example.test");
		await git(cwd, "config", "commit.gpgsign", "false");
		await git(cwd, "switch", "-q", "-c", branch);
		const command = (...args: string[]) =>
			run([process.execPath, cli, ...args], cwd);
		const installed = await command("install-git-hooks");
		if (!installed.ok) throw new Error(installed.output);
		return {
			cwd,
			branch,
			git: (...args: string[]) => git(cwd, ...args),
			push: () => run(["git", "push", "origin", "HEAD"], cwd),
			lease: (action: string, flags: string[] = [], options?: RunOptions) =>
				run(
					[
						process.execPath,
						cli,
						"lease",
						action,
						...(action === "list" ? [] : [name]),
						...flags,
					],
					cwd,
					options,
				),
			configure: (check: string, branchName = "off") =>
				Bun.write(join(cwd, "cagr.toml"), config(check, branchName)),
			migration: async (number: string) => {
				const file = `migrations/${number}.sql`;
				await Bun.write(join(cwd, file), `${branch}\n`);
				await git(cwd, "add", file);
				await git(
					cwd,
					"commit",
					"-qm",
					`feat: migration ${number} for ${branch}`,
				);
			},
		};
	};
	const remote = (...args: string[]) => git(origin, ...args);
	const setRecord = async (ref: string, data: string) => {
		const result = await run(["git", "hash-object", "-w", "--stdin"], origin, {
			stdin: data,
		});
		if (!result.ok) throw new Error(result.output);
		await remote("update-ref", ref, result.stdout.trim());
	};
	const setRenewal = async (ref: string, renewed: number) => {
		const record = JSON.parse(await remote("cat-file", "blob", ref));
		await setRecord(ref, JSON.stringify({ ...record, renewed }));
	};
	const merge = async (builder: { cwd: string; branch: string }) => {
		await remote(
			"update-ref",
			"refs/heads/main",
			`refs/heads/${builder.branch}`,
		);
	};
	return { builder, remote, setRecord, setRenewal, merge, origin, parent };
}

test("two clones contend and the non-holder's migration push is refused", async () => {
	const { builder, remote } = await fixture();
	const a = await builder("builder-a");
	const b = await builder("builder-b");
	await a.migration("0002");
	await b.migration("0002");
	const taken = await a.lease("take");
	expect(taken.stdout).toContain(
		"Acquired db-migrations for builder-a.\nMerge main and regenerate.",
	);
	const queued = await b.lease("take");
	expect(queued.exitCode).toBe(1);
	expect(queued.stdout).toContain("held by builder-a, builder-b is #1 in line");
	const denied = await b.push();
	expect(denied.exitCode).toBe(1);
	expect(denied.stderr).toContain(
		"Run `cagr lease take db-migrations` on builder-b",
	);
	expect(await remote("branch", "--list", "builder-b")).toBe("");
	const renamed = await run(
		["git", "push", "origin", "HEAD:refs/heads/builder-a"],
		b.cwd,
	);
	expect(renamed.stderr).toContain("Changes to db-migrations need its lease");
	expect((await a.lease("list")).stdout).toContain(
		"db-migrations: builder-a held by",
	);
	expect((await a.push()).ok).toBe(true);
});

test("three builders land 0002 through 0004 in ticket order", async () => {
	const { builder, merge, remote } = await fixture();
	const a = await builder("builder-a");
	const b = await builder("builder-b");
	const c = await builder("builder-c");
	expect((await a.lease("take")).ok).toBe(true);
	expect((await b.lease("take")).stdout).toContain("#1 in line");
	expect((await c.lease("take")).stdout).toContain(
		"#2 in line behind builder-b",
	);
	const line = (await a.lease("list")).stdout;
	expect(line).toMatch(/db-migrations: builder-a held by .*age .*last renewed/);
	expect(line).toMatch(/#1 builder-b[^\n]*\n {2}#2 builder-c/);
	const land = async (lander: typeof a, number: string) => {
		await lander.git("fetch", "origin", "main");
		await lander.git("merge", "--no-edit", "origin/main");
		await lander.migration(number);
		const pushed = await lander.push();
		if (!pushed.ok) throw new Error(pushed.output);
		await merge(lander);
	};
	await land(a, "0002");
	expect((await c.lease("take")).exitCode).toBe(1);
	expect((await b.lease("take")).ok).toBe(true);
	const waiting = Bun.spawn(
		[process.execPath, cli, "lease", "take", name, "--wait"],
		{
			cwd: c.cwd,
			stdout: "pipe",
			stderr: "inherit",
		},
	);
	const reader = waiting.stdout.getReader();
	const decoder = new TextDecoder();
	try {
		let output = "";
		while (!output.includes("\n")) {
			const { value, done } = await reader.read();
			if (done)
				throw new Error(
					`Waiter exited before reporting its position: ${output}`,
				);
			output += decoder.decode(value, { stream: true });
		}
		expect(output).toContain("held by builder-b, builder-c is #1 in line");
		await land(b, "0003");
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			output += decoder.decode(value, { stream: true });
		}
		expect(output).toContain("Acquired db-migrations for builder-c");
		expect(await waiting.exited).toBe(0);
	} finally {
		reader.releaseLock();
		if (waiting.exitCode === null) waiting.kill();
	}

	await land(c, "0004");
	expect(
		await remote("ls-tree", "-r", "--name-only", "main", "migrations"),
	).toBe(
		["0001", "0002", "0003", "0004"]
			.map((n) => `migrations/${n}.sql`)
			.join("\n"),
	);
});

test("expired holders and dead tickets give way to the next live ticket", async () => {
	const { builder, remote, setRenewal } = await fixture();
	const a = await builder("builder-a");
	const b = await builder("builder-b");
	const c = await builder("builder-c");
	expect((await a.lease("take")).ok).toBe(true);
	expect((await b.lease("take")).exitCode).toBe(1);
	expect((await c.lease("take")).exitCode).toBe(1);
	const dead = (await remote("for-each-ref", "--format=%(refname)", waitPrefix))
		.split("\n")
		.find((ref) => ref.endsWith(Buffer.from(b.branch).toString("base64url")));
	expect(dead).toBeDefined();
	await setRenewal(leaseRef, 0);
	await setRenewal(dead as string, 0);
	expect((await a.lease("renew")).stderr).toContain("expired");
	expect((await c.lease("take")).stdout).toContain(
		"Acquired db-migrations for builder-c",
	);
	expect(await remote("for-each-ref", waitPrefix)).toBe("");
});

test("a contender can reclaim after an ordinary merge", async () => {
	const { builder, merge } = await fixture();
	const a = await builder("builder-a");
	const b = await builder("builder-b");
	expect((await a.lease("take")).ok).toBe(true);
	await a.migration("0002");
	expect((await a.push()).ok).toBe(true);
	await merge(a);
	expect((await b.lease("take")).stdout).toContain(
		"Acquired db-migrations for builder-b",
	);
});

test("a contender can reclaim when an observed remote branch is deleted", async () => {
	const { builder, remote } = await fixture();
	const a = await builder("builder-a");
	const b = await builder("builder-b");
	expect((await a.push()).ok).toBe(true);
	expect((await a.lease("take")).ok).toBe(true);
	await remote("update-ref", "-d", "refs/heads/builder-a");
	expect((await b.lease("take")).stdout).toContain(
		"Acquired db-migrations for builder-b",
	);
});

for (const failure of ["verify", "refusal"]) {
	test(`the hook releases the holder on ${failure} failure`, async () => {
		const { builder } = await fixture();
		const a = await builder("builder-a");
		const b = await builder("builder-b");
		expect((await a.lease("take")).ok).toBe(true);
		await a.migration("0002");
		await a.configure(
			failure === "verify" ? "echo verify failed; exit 1" : "true",
			failure === "refusal" ? "type/name" : "off",
		);
		const failed = await a.push();
		expect(failed.exitCode).toBe(1);
		expect(failed.stderr).toContain(
			failure === "verify" ? "verify failed" : "branch-name",
		);
		expect(failed.stderr).toContain("Released db-migrations");
		expect((await b.lease("take")).ok).toBe(true);
	});
}

test("a live break takes human authorization and logs the actor and time", async () => {
	const { builder } = await fixture();
	const a = await builder("builder-a");
	const b = await builder("builder-b");
	expect((await a.lease("take")).ok).toBe(true);
	expect((await b.lease("release", ["--break"])).stderr).toContain(
		"is still held",
	);
	const broken = await b.lease("release", ["--break"], {
		env: { CAGR_ALLOW_LEASE_BREAK: "1" },
	});
	expect(broken.stdout).toMatch(
		/^\d{4}-.* broke db-migrations held by builder-a at [a-f0-9]+/,
	);
	expect(await readFile(join(b.cwd, ".git/cagr/leases.log"), "utf8")).toBe(
		broken.stdout,
	);
	expect((await b.lease("take")).ok).toBe(true);
});

test("renewal prevents a stale CAS from deleting the current lease", async () => {
	const { builder, remote } = await fixture();
	const a = await builder("builder-a");
	const b = await builder("builder-b");
	expect((await a.lease("take")).ok).toBe(true);
	const old = await remote("rev-parse", leaseRef);
	expect((await a.lease("renew")).ok).toBe(true);
	const renewed = await remote("rev-parse", leaseRef);
	expect(renewed).not.toBe(old);
	expect(await new LeaseRefs(b.cwd).change(leaseRef, old, null)).toBeNull();
	expect(await remote("rev-parse", leaseRef)).toBe(renewed);
});

test("the lease stays live during verification and passes admission priority", async () => {
	const { builder } = await fixture(5);
	const a = await builder("builder-a");
	await a.migration("0002");
	await a.configure('sleep 6; test "$CAGR_PRIORITY" = lease');
	expect((await a.lease("take")).ok).toBe(true);
	const pushed = await run(
		[
			"git",
			"-C",
			a.cwd,
			"-c",
			"test.value=contains --dry-run",
			"push",
			"origin",
			"HEAD",
		],
		tmpdir(),
	);
	expect(pushed.output).toContain("-> builder-a");
	expect(pushed.ok).toBe(true);
});

test("a reverted leased change on an unpublished branch leaves the tree unchanged", async () => {
	const { builder } = await fixture();
	const a = await builder("builder-a");
	await a.migration("0002");
	await a.git("revert", "--no-edit", "HEAD");
	expect((await a.push()).ok).toBe(true);
});

test("CI rejects an expired published lease and a failed update keeps a live one", async () => {
	const { builder, parent, remote, setRenewal } = await fixture();
	const a = await builder("builder-a");
	await a.migration("0002");
	expect((await a.lease("take")).ok).toBe(true);
	expect((await a.push()).ok).toBe(true);
	const event = join(parent, "pull-request.json");
	const sha = await a.git("rev-parse", "HEAD");
	const writeEvent = (repo: { full_name: string } | null) =>
		Bun.write(
			event,
			JSON.stringify({ pull_request: { head: { sha, ref: a.branch, repo } } }),
		);
	const ci = () =>
		run([process.execPath, cli, "ci"], a.cwd, {
			env: { GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: "example/leases" },
		});
	await writeEvent(null);
	expect((await ci()).stdout).toContain("FAIL Leases");
	await writeEvent({ full_name: "example/leases" });
	const live = await ci();
	expect(live.stdout).toContain("PASS Leases");
	expect(live.ok).toBe(true);
	await setRenewal(leaseRef, 0);
	const expired = await ci();
	expect(expired.ok).toBe(false);
	expect(expired.stdout).toContain("FAIL Leases");
	expect(expired.stdout).toContain("cagr lease take db-migrations");
	expect((await a.lease("take")).ok).toBe(true);
	await a.configure("exit 1");
	await a.migration("0003");
	const failed = await a.push();
	expect(failed.ok).toBe(false);
	expect(failed.stderr).toContain("Kept db-migrations");
	expect(await remote("rev-parse", leaseRef)).toMatch(/^[a-f0-9]+$/);
});

test("dry-run pushes leave remote lease refs unchanged on success and refusal", async () => {
	const { builder, remote } = await fixture();
	const a = await builder("builder-a");
	await a.migration("0002");
	expect((await a.lease("take")).ok).toBe(true);
	const before = await remote("for-each-ref", "refs/cagr/");
	const dry = (flag: string) =>
		run(["git", "-C", a.cwd, "push", flag, "origin", "HEAD"], tmpdir());
	expect((await dry("--dry-run")).ok).toBe(true);
	expect(await remote("for-each-ref", "refs/cagr/")).toBe(before);
	await a.configure("exit 1");
	expect((await dry("-n")).ok).toBe(false);
	expect(await remote("for-each-ref", "refs/cagr/")).toBe(before);
});

test("a configured push refspec cannot write a serial ref", async () => {
	const { builder } = await fixture();
	const a = await builder("builder-a");
	await a.git("config", "remote.origin.push", `HEAD:${leaseRef}`);
	const pushed = await run(["git", "push", "origin"], a.cwd);
	expect(pushed.ok).toBe(false);
	expect(pushed.stderr).toContain("Use cagr lease");
});

test("a main-only migration brought in by a merge needs no lease", async () => {
	const { builder, merge } = await fixture();
	const a = await builder("builder-a");
	const b = await builder("builder-b");
	expect((await b.push()).ok).toBe(true);
	await b.git("commit", "--allow-empty", "-m", "chore: work on builder b");
	expect((await a.lease("take")).ok).toBe(true);
	await a.migration("0002");
	expect((await a.push()).ok).toBe(true);
	await merge(a);
	await b.git("fetch", "origin", "main");
	await b.git("merge", "--no-edit", "origin/main");
	expect((await b.push()).ok).toBe(true);
});

test("a merge that inherits a leased deletion from its side parent needs the lease", async () => {
	const { builder } = await fixture();
	const a = await builder("builder-a");
	const b = await builder("builder-b");
	await a.migration("0002");
	expect((await a.lease("take")).ok).toBe(true);
	expect((await a.push()).ok).toBe(true);
	expect((await a.lease("release")).ok).toBe(true);
	await b.git("commit", "--allow-empty", "-qm", "chore: work on builder b");
	await a.git("fetch", b.cwd, "builder-b");
	await a.git("merge", "--no-commit", "--no-ff", "FETCH_HEAD");
	await a.git("rm", "migrations/0002.sql");
	await a.git("commit", "-qm", "fix: keep the side parent's migration tree");
	const result = await a.push();
	expect(result.ok).toBe(false);
	expect(result.stderr).toContain("Changes to db-migrations need its lease");
});

test("a forced rewind that removes a leased change needs the lease", async () => {
	const { builder } = await fixture();
	const a = await builder("builder-a");
	await a.migration("0002");
	expect((await a.lease("take")).ok).toBe(true);
	expect((await a.push()).ok).toBe(true);
	expect((await a.lease("release")).ok).toBe(true);
	const configFile = join(a.cwd, "cagr.toml");
	await Bun.write(
		configFile,
		(await Bun.file(configFile).text()).replace(
			"block_force_push = true",
			"block_force_push = false",
		),
	);
	const result = await run(
		["git", "push", "--force", "origin", "HEAD^:refs/heads/builder-a"],
		a.cwd,
	);
	expect(result.ok).toBe(false);
	expect(result.stderr).toContain("Changes to db-migrations need its lease");
});

test("take skips and logs malformed records, and a human can prune tickets directly", async () => {
	const { builder, remote, setRecord } = await fixture();
	const a = await builder("builder-a");
	const broken = `${waitPrefix}123-broken`;
	await setRecord(leaseRef, "not a lease");
	await setRecord(broken, JSON.stringify(holder("builder-b\u001b[2J")));
	const listed = await a.lease("list");
	expect(listed.stdout).toContain("malformed lease");
	expect(listed.stdout).not.toContain("\u001b");
	expect(listed.stdout).toContain(`Ignored malformed ticket at ${broken}`);
	const pruned = await a.lease("release", ["--break", "--prune-tickets"]);
	expect(pruned.stdout).toContain(
		`Pruned malformed serial record at ${broken}`,
	);
	expect(await remote("for-each-ref", waitPrefix)).toBe("");
	await setRecord(broken, "still not a ticket");
	const taken = await a.lease("take");
	expect(taken.stdout).toContain(
		`Pruned malformed serial record at ${leaseRef}`,
	);
	expect(taken.stdout).toContain(`Pruned malformed serial record at ${broken}`);
	expect(taken.stdout).toContain("Acquired db-migrations for builder-a");
	expect(await remote("for-each-ref", waitPrefix)).toBe("");
});

async function withCommand(dir: string, name: string, script: string) {
	const file = join(dir, name);
	await Bun.write(file, `#!/bin/sh\nset -eu\n${script}\n`);
	await chmod(file, 0o755);
	return { env: { PATH: `${dir}:${process.env.PATH}` } };
}

test("a renewal CAS that leaves too little time cannot clear pre-push", async () => {
	const { builder, origin, remote } = await fixture(5);
	const a = await builder("builder-a");
	const zero = "0".repeat(40);
	await withCommand(
		join(origin, "hooks"),
		"pre-receive",
		`
while read -r old new ref; do
  if test "$ref" = ${leaseRef} && test "$old" != ${zero} && test "$new" != ${zero}; then
    sleep 3
  fi
done`,
	);
	await a.migration("0002");
	expect((await a.lease("take")).ok).toBe(true);
	const before = await remote("rev-parse", leaseRef);
	const result = await a.push();
	expect(result.ok).toBe(false);
	expect(result.stderr).toContain("too little time left");
	expect(await remote("rev-parse", leaseRef)).not.toBe(before);
	expect(await remote("branch", "--list", a.branch)).toBe("");
});

test("take relists tied tickets before it claims a free lease", async () => {
	const { builder, origin, parent, remote, setRecord } = await fixture();
	const c = await builder("builder-c");
	const acquired = Date.now();
	const ticketRef = (branch: string) =>
		`${waitPrefix}${acquired}-${Buffer.from(branch).toString("base64url")}`;
	const record = (branch: string) =>
		JSON.stringify({ ...holder(branch), acquired, renewed: acquired });
	await setRecord(ticketRef(c.branch), record(c.branch));
	await setRecord("refs/fixture/new-ticket", record("builder-b"));
	const realGit = shellQuote(Bun.which("git") as string);
	const options = await withCommand(
		parent,
		"git",
		`
if test "$1" = rev-parse && test "${"$"}{2-}" = HEAD; then
  ${realGit} --git-dir=${shellQuote(origin)} update-ref ${shellQuote(ticketRef("builder-b"))} refs/fixture/new-ticket
fi
exec ${realGit} "$@"`,
	);
	const queued = await c.lease("take", [], options);
	expect(queued.exitCode).toBe(1);
	expect(queued.stdout).toContain("builder-c is #2 in line behind builder-b");
	expect(await remote("for-each-ref", leaseRef)).toBe("");
});

test("a squash merge and automatic branch deletion permit the next holder", async () => {
	const { builder, parent, origin, remote } = await fixture();
	const a = await builder("builder-a");
	const b = await builder("builder-b");
	await a.migration("0002");
	expect((await a.lease("take")).ok).toBe(true);
	expect((await a.push()).ok).toBe(true);
	await b.git("fetch", "origin", a.branch);
	await b.git("merge", "--squash", "FETCH_HEAD");
	await b.git("commit", "-qm", "feat: squash migration onto main");
	await b.git("push", "--no-verify", "origin", "HEAD:refs/heads/main");
	await remote("update-ref", "-d", "refs/heads/builder-a");
	await b.git(
		"remote",
		"set-url",
		"origin",
		"https://github.com/example/leases.git",
	);
	await b.git(
		"config",
		`url.${origin}.insteadOf`,
		"https://github.com/example/leases.git",
	);
	const merged = {
		headRefOid: await a.git("rev-parse", "HEAD"),
		isCrossRepository: false,
		mergedAt: new Date().toISOString(),
	};
	const options = await withCommand(
		parent,
		"gh",
		`
test "$*" = "pr list --repo github.com/example/leases --head builder-a --base main --state merged --json headRefOid,isCrossRepository,mergedAt"
echo ${shellQuote(JSON.stringify([merged]))}`,
	);
	expect((await b.lease("take", [], options)).stdout).toContain(
		"Acquired db-migrations for builder-b",
	);
});
