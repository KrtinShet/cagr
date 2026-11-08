import { basename } from "node:path";

const separators = new Set([";", "&", "|", "\n", "(", ")", "`"]);
const wrappers = new Set(["sudo", "env", "command", "exec", "time", "nohup"]);
const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Splits a shell command line into simple commands, each a list of words with
 * quotes removed. Good enough to read intent, not a full shell parser.
 */
export function simpleCommands(line: string): string[][] {
	return split(line).commands;
}

/** Like simpleCommands, with whether each command runs in a subshell: `( )`, `$( )` or backticks. */
export function commandsWithNesting(
	line: string,
): { words: string[]; nested: boolean }[] {
	const splitter = split(line);
	return splitter.commands.map((words, index) => ({
		words,
		nested: splitter.nested[index] ?? false,
	}));
}

function split(line: string) {
	const splitter = new Splitter();
	for (let index = 0; index < line.length; index++)
		index = splitter.read(line, index);
	splitter.endCommand();
	return splitter;
}

class Splitter {
	commands: string[][] = [];
	nested: boolean[] = [];
	private words: string[] = [];
	private word = "";
	private inWord = false;
	private depth = 0;
	private inBacktick = false;

	read(line: string, index: number): number {
		const char = line[index] as string;
		if (char === "'" || char === '"') {
			const quoted = readQuoted(line, index);
			this.add(quoted.text);
			return quoted.end;
		}
		if (char === "\\" && index + 1 < line.length) {
			if (line[index + 1] !== "\n") this.add(line[index + 1] as string);
			return index + 1;
		}
		if (char === "$" && line[index + 1] === "(") {
			this.endCommand();
			this.depth++;
			return index + 1;
		}
		if (separators.has(char)) {
			this.endCommand();
			if (char === "(") this.depth++;
			else if (char === ")") this.depth = Math.max(0, this.depth - 1);
			else if (char === "`") this.inBacktick = !this.inBacktick;
		} else if (char === " " || char === "\t") this.endWord();
		else this.add(char);
		return index;
	}

	endCommand() {
		this.endWord();
		if (this.words.length > 0) {
			this.commands.push(this.words);
			this.nested.push(this.depth > 0 || this.inBacktick);
		}
		this.words = [];
	}

	private endWord() {
		if (this.inWord) this.words.push(this.word);
		this.word = "";
		this.inWord = false;
	}

	private add(text: string) {
		this.word += text;
		this.inWord = true;
	}
}

function readQuoted(line: string, start: number) {
	const quote = line[start];
	let text = "";
	let index = start + 1;
	for (; index < line.length && line[index] !== quote; index++) {
		// Inside double quotes a backslash escapes the next character, and joins a line.
		if (quote === '"' && line[index] === "\\" && index + 1 < line.length) {
			index++;
			if (line[index] === "\n") continue;
		}
		text += line[index];
	}
	return { text, end: index };
}

export function programWords(words: string[]): string[] {
	let start = 0;
	while (start < words.length) {
		const word = words[start] as string;
		if (assignment.test(word) || wrappers.has(word)) start++;
		else break;
	}
	return words.slice(start);
}

const heredocStart = /(?<!<)<<(?!<)-?\s*(['"]?)(\w+)\1/g;

/** Drops heredoc bodies: they are text fed to a command, not commands to run. */
export function withoutHeredocBodies(line: string): string {
	const kept: string[] = [];
	let delimiter: string | null = null;
	for (const text of line.split("\n")) {
		if (delimiter !== null) {
			if (text.trim() === delimiter) delimiter = null;
			continue;
		}
		kept.push(text);
		const opened = [...text.matchAll(heredocStart)].at(-1);
		if (opened) delimiter = opened[2] ?? null;
	}
	return kept.join("\n");
}

/** The program's name without its directory or .exe, so `/usr/bin/git` and `git.exe` are git. */
export const programName = (words: string[]) =>
	basename(words[0] ?? "").replace(/\.exe$/i, "");
