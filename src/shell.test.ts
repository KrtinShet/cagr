import { describe, expect, test } from "bun:test";
import { commandsWithNesting, programWords, simpleCommands } from "./shell";

describe("simpleCommands", () => {
	test("splits on control operators", () => {
		expect(simpleCommands("cd app && bun test; git status | cat")).toEqual([
			["cd", "app"],
			["bun", "test"],
			["git", "status"],
			["cat"],
		]);
	});

	test("reads >&, <& and &> as redirections, not a background &", () => {
		expect(
			simpleCommands("git push 2>&1 | tail -2 && cat <&3 &>log; bun x & ls"),
		).toEqual([
			["git", "push", "2>&1"],
			["tail", "-2"],
			["cat", "<&3", "&>log"],
			["bun", "x"],
			["ls"],
		]);
	});

	test("keeps quoted text as one word", () => {
		expect(
			simpleCommands(`git commit -m "fix: drop --no-verify; use bun"`),
		).toEqual([["git", "commit", "-m", "fix: drop --no-verify; use bun"]]);
	});

	test("reads single quotes literally", () => {
		expect(simpleCommands(`echo 'a "b" \\c'`)).toEqual([["echo", 'a "b" \\c']]);
	});

	test("keeps empty quoted words", () => {
		expect(simpleCommands(`printf '' x`)).toEqual([["printf", "", "x"]]);
	});

	test("treats command substitution as its own command", () => {
		expect(simpleCommands("echo $(npm -v)")).toEqual([["echo"], ["npm", "-v"]]);
	});

	test("joins lines continued with a backslash", () => {
		expect(simpleCommands("git push \\\n  origin main")).toEqual([
			["git", "push", "origin", "main"],
		]);
	});
});

describe("programWords", () => {
	test("skips env assignments and wrappers", () => {
		expect(programWords(["CI=1", "sudo", "env", "A=b", "npm", "i"])).toEqual([
			"npm",
			"i",
		]);
	});
});

describe("commandsWithNesting", () => {
	test("marks commands inside ( ), $( ) and backticks", () => {
		expect(
			commandsWithNesting(
				"git add . && (cd /x) && echo $(git switch b) `pwd` && gh pr create",
			).map(({ words, nested }) => [words[0], nested]),
		).toEqual([
			["git", false],
			["cd", true],
			["echo", false],
			["git", true],
			["pwd", true],
			["gh", false],
		]);
	});
});
