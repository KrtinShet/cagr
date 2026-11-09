import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	bumpVersion,
	commitBump,
	plan,
	releaseBump,
	writeVersion,
} from "./next-version";

describe("commitBump", () => {
	test("feat is minor, fix and perf are patch, the rest nothing", () => {
		expect(commitBump("feat(rules): share utils (#21)")).toBe("minor");
		expect(commitBump("fix: a crash")).toBe("patch");
		expect(commitBump("perf(hook): faster")).toBe("patch");
		for (const message of [
			"docs(cli): help",
			"ci: release",
			"chore(release): v0.3.0 (#30)",
			"test: more",
			"Merge pull request #12 from x/y",
			"featured thing",
		])
			expect(commitBump(message)).toBeNull();
	});

	test("! or a BREAKING CHANGE footer is major", () => {
		expect(commitBump("feat(config)!: rename keys")).toBe("major");
		expect(commitBump("fix: x\n\nBREAKING CHANGE: the flag is gone")).toBe(
			"major",
		);
		expect(commitBump("fix: x\n\nBREAKING-CHANGE: gone")).toBe("major");
		expect(commitBump("fix: mention BREAKING CHANGE: inline")).toBe("patch");
	});
});

test("releaseBump takes the largest", () => {
	expect(releaseBump(["docs: a", "fix: b"])).toBe("patch");
	expect(releaseBump(["fix: b", "feat: c", "fix: d"])).toBe("minor");
	expect(releaseBump(["feat: c", "fix!: d"])).toBe("major");
	expect(releaseBump(["docs: a", "ci: b"])).toBeNull();
	expect(releaseBump([])).toBeNull();
});

test("bumpVersion follows semver, with breaking bumping the middle number before 1.0", () => {
	expect(bumpVersion("0.2.0", "patch")).toBe("0.2.1");
	expect(bumpVersion("0.2.3", "minor")).toBe("0.3.0");
	expect(bumpVersion("0.2.3", "major")).toBe("0.3.0");
	expect(bumpVersion("1.2.3", "major")).toBe("2.0.0");
	expect(bumpVersion("1.2.3", "minor")).toBe("1.3.0");
	expect(() => bumpVersion("0.2", "patch")).toThrow("not a plain x.y.z");
	expect(() => bumpVersion("0.2.0-rc.1", "patch")).toThrow();
});

function repo(version: string) {
	const root = mkdtempSync(join(tmpdir(), "cagr-release-"));
	mkdirSync(join(root, "src"));
	writeFileSync(
		join(root, "package.json"),
		`{\n\t"name": "x",\n\t"version": "${version}",\n\t"private": true\n}\n`,
	);
	writeFileSync(
		join(root, "src/version.ts"),
		`export const version = "${version}";\n`,
	);
	const run = (...args: string[]) => {
		const result = Bun.spawnSync(["git", ...args], {
			cwd: root,
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "t",
				GIT_AUTHOR_EMAIL: "t@example.com",
				GIT_COMMITTER_NAME: "t",
				GIT_COMMITTER_EMAIL: "t@example.com",
			},
		});
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	};
	run("init", "-q", "-b", "main");
	// The user's global signing setup must not reach these throwaway commits and tags.
	run("config", "commit.gpgsign", "false");
	run("config", "tag.gpgsign", "false");
	run("add", "-A");
	run("commit", "-qm", "chore: start");
	const commit = (message: string) =>
		run("commit", "-q", "--allow-empty", "-m", message);
	return { root, run, commit };
}

describe("writeVersion", () => {
	test("changes only the version, keeping the formatting", () => {
		const { root } = repo("0.2.0");
		writeVersion(root, "0.3.0");
		expect(readFileSync(join(root, "package.json"), "utf8")).toBe(
			'{\n\t"name": "x",\n\t"version": "0.3.0",\n\t"private": true\n}\n',
		);
		expect(readFileSync(join(root, "src/version.ts"), "utf8")).toBe(
			'export const version = "0.3.0";\n',
		);
	});
});

describe("plan", () => {
	test("counts the commits since the current version's tag", () => {
		const { root, run, commit } = repo("0.2.0");
		run("tag", "v0.2.0");
		commit("docs: a page");
		commit("fix(rules): a crash (#3)");
		commit("feat(rules): shared utils (#4)");
		expect(plan(root)).toEqual({
			current: "0.2.0",
			next: "0.3.0",
			since: "v0.2.0",
			commits: ["feat(rules): shared utils (#4)", "fix(rules): a crash (#3)"],
		});
	});

	test("nothing to release when only docs or ci changed", () => {
		const { root, run, commit } = repo("0.2.0");
		run("tag", "v0.2.0");
		commit("docs: a page");
		expect(plan(root).next).toBeNull();
	});

	test("an untagged version in the code is a pending release, so no new one is planned", () => {
		const { root, run, commit } = repo("0.2.0");
		run("tag", "v0.1.0", "HEAD");
		commit("feat: more");
		expect(plan(root)).toEqual({
			current: "0.2.0",
			next: null,
			since: "v0.1.0",
			commits: [],
		});
	});
});
