import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tempRepo } from "../test/repo";
import { checkLockfile, isLockfile, type LockfileStack } from "./lockfile";

const roots = new Set<string>();
afterEach(async () => {
	await Promise.all(
		[...roots].map((root) => rm(root, { recursive: true, force: true })),
	);
	roots.clear();
});

const stack = (
	package_manager: LockfileStack["package_manager"],
	paths = ["**"],
	exclude_paths: string[] = [],
): LockfileStack => ({ paths, exclude_paths, package_manager });

async function check(path: string, stacks: LockfileStack[], write = true) {
	const repo = await tempRepo();
	roots.add(repo.root);
	if (write) await repo.write(path, "{}\n");
	return checkLockfile({
		root: repo.root,
		path,
		stacks,
		baseline: null,
		head: null,
		deadline: performance.now() + 10_000,
	});
}

test("only the JavaScript lockfiles are checked against their manager", () => {
	expect(
		["bun.lock", "web/pnpm-lock.yaml", "package-lock.json", "yarn.lock"].every(
			isLockfile,
		),
	).toBe(true);
	expect(
		["bun.lockb", "uv.lock", "Cargo.lock", "go.sum"].some(isLockfile),
	).toBe(false);
});

test("a lockfile with no covering stack names the missing package_manager", async () => {
	const verdict = await check("web/bun.lock", [
		stack(null),
		stack("bun", ["api/**"]),
		stack("bun", ["**"], ["web/**"]),
	]);
	expect(verdict?.message).toContain(
		"only when a [[stack]] with package_manager covers web/bun.lock",
	);
});

test("a lockfile the stack's manager does not write says which manager to use", async () => {
	const verdict = await check("package-lock.json", [stack("pnpm")]);
	expect(verdict?.message).toContain(
		"uses pnpm, which does not write package-lock.json",
	);
});

test("a JavaScript stack is chosen over another ecosystem's on the same paths", async () => {
	const other = await check("package-lock.json", [stack("uv"), stack("bun")]);
	expect(other?.message).toContain("uses bun, which does not write");
	const only = await check("bun.lock", [stack("uv")]);
	expect(only?.message).toContain("only when a [[stack]] with package_manager");
	const writer = await check("bun.lock", [stack("pnpm"), stack("bun")], false);
	expect(writer?.message).toContain("bun.lock is deleted");
});

test("a deleted lockfile, or a folder in its place, asks for a restore", async () => {
	const deleted = await check("bun.lock", [stack("bun")], false);
	expect(deleted?.message).toContain("bun.lock is deleted");
	const repo = await tempRepo();
	roots.add(repo.root);
	await repo.write("bun.lock/inner", "x\n");
	const verdict = await checkLockfile({
		root: repo.root,
		path: "bun.lock",
		stacks: [stack("bun")],
		baseline: null,
		head: null,
		deadline: performance.now() + 10_000,
	});
	expect(verdict?.message).toContain("bun.lock is not a regular file");
});

test("other files are left to the plain protected-file check", async () => {
	expect(await check("Cargo.lock", [stack("bun")])).toBeNull();
});
