import { expect, test } from "bun:test";
import { editedFiles } from "./edited-files";

test("reads Claude Code's file_path", () => {
	expect(
		editedFiles({ file_path: "/repo/a.ts", old_string: "x" }, "/repo"),
	).toEqual(["/repo/a.ts"]);
});

test("reads every file in a Codex patch, relative to cwd", () => {
	const patch = [
		"*** Begin Patch",
		"*** Add File: apps/web/src/lib/new.ts",
		"+export const a = 1;",
		"*** Update File: tools/stack/src/cli.ts",
		"*** Move to: tools/stack/src/main.ts",
		"@@",
		"*** Delete File: old.ts",
		"*** End Patch",
	].join("\n");
	expect(editedFiles({ command: patch }, "/repo")).toEqual([
		"/repo/apps/web/src/lib/new.ts",
		"/repo/tools/stack/src/cli.ts",
		"/repo/tools/stack/src/main.ts",
	]);
});

test("reads a Codex patch sent as argv", () => {
	const patch =
		"*** Begin Patch\n*** Update File: .env\n@@\n-A=1\n+A=2\n*** End Patch\n";
	expect(editedFiles({ command: ["apply_patch", patch] }, "/repo")).toEqual([
		"/repo/.env",
	]);
	expect(editedFiles({ patch }, "/repo")).toEqual(["/repo/.env"]);
});

test("ignores a shell command and odd input", () => {
	expect(editedFiles({ command: "git status" }, "/repo")).toEqual([]);
	expect(editedFiles(null, "/repo")).toEqual([]);
});

test("reads Claude Code's notebook_path", () => {
	expect(editedFiles({ notebook_path: "nb.ipynb" }, "/repo")).toEqual([
		"/repo/nb.ipynb",
	]);
});
