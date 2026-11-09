// Works out the next release from the conventional commits since the last tag.
// Usage: bun scripts/next-version.ts            prints the plan as JSON
//        bun scripts/next-version.ts --write    also sets it in package.json and src/version.ts
// The release workflow uses it to keep the release pull request up to date. docs/releasing.md has the flow.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Bump = "major" | "minor" | "patch";

const header = /^(\w+)(?:\([^)]*\))?(!)?:\s/;

/** The bump one commit message asks for, or null for docs, ci, chore and the like. */
export function commitBump(message: string): Bump | null {
	const match = message.match(header);
	if (!match) return null;
	if (match[2] || /^BREAKING[ -]CHANGE:/m.test(message)) return "major";
	if (match[1] === "feat") return "minor";
	if (match[1] === "fix" || match[1] === "perf") return "patch";
	return null;
}

const order: (Bump | null)[] = [null, "patch", "minor", "major"];

/** The largest bump the messages ask for. */
export function releaseBump(messages: string[]): Bump | null {
	let best: Bump | null = null;
	for (const message of messages) {
		const bump = commitBump(message);
		if (order.indexOf(bump) > order.indexOf(best)) best = bump;
	}
	return best;
}

/** Semver, with the 0.x rule from docs/releasing.md: before 1.0, a breaking change bumps the middle number. */
export function bumpVersion(version: string, bump: Bump): string {
	const parts = version.split(".").map(Number);
	if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part)))
		throw new Error(
			`"${version}" is not a plain x.y.z version. Fix src/version.ts.`,
		);
	const [major, minor, patch] = parts as [number, number, number];
	if (bump === "major" && major > 0) return `${major + 1}.0.0`;
	if (bump === "major" || bump === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

/** Sets the version in package.json and src/version.ts, keeping their formatting. */
export function writeVersion(root: string, version: string) {
	const files: [string, RegExp, string][] = [
		["package.json", /("version":\s*")[^"]+(")/, `$1${version}$2`],
		["src/version.ts", /(version\s*=\s*")[^"]+(")/, `$1${version}$2`],
	];
	for (const [file, pattern, replacement] of files) {
		const path = join(root, file);
		const text = readFileSync(path, "utf8");
		if (!pattern.test(text))
			throw new Error(`No version found in ${file}. Keep a "version" there.`);
		writeFileSync(path, text.replace(pattern, replacement));
	}
}

export type Plan = {
	current: string;
	/** The version to release next, or null when no commit since the last release asks for one. */
	next: string | null;
	/** The last release tag the commits are counted from, or null for the first release. */
	since: string | null;
	commits: string[];
};

function git(root: string, args: string[]) {
	const result = Bun.spawnSync(["git", ...args], { cwd: root });
	if (result.exitCode !== 0)
		throw new Error(
			`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`,
		);
	return result.stdout.toString();
}

export function plan(root: string): Plan {
	const current = (
		readFileSync(join(root, "src/version.ts"), "utf8").match(
			/version\s*=\s*"([^"]+)"/,
		)?.[1] ?? ""
	).trim();
	const tags = git(root, [
		"tag",
		"--list",
		"v[0-9]*.[0-9]*.[0-9]*",
		"--merged",
		"HEAD",
		"--sort=-v:refname",
	])
		.split("\n")
		.filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
	// The code's version not tagged yet means a release is still pending: it ships first.
	if (!tags.includes(`v${current}`))
		return { current, next: null, since: tags[0] ?? null, commits: [] };
	const since = `v${current}`;
	const messages = git(root, [
		"log",
		`${since}..HEAD`,
		"--no-merges",
		"--format=%B%x00",
	])
		.split("\0")
		.map((message) => message.trim())
		.filter(Boolean);
	const bump = releaseBump(messages);
	return {
		current,
		next: bump ? bumpVersion(current, bump) : null,
		since,
		commits: messages
			.filter((message) => commitBump(message))
			.map((message) => message.split("\n")[0] as string),
	};
}

if (import.meta.main) {
	const root = join(import.meta.dir, "..");
	const result = plan(root);
	if (process.argv.includes("--write") && result.next)
		writeVersion(root, result.next);
	console.log(JSON.stringify(result, null, 2));
}
