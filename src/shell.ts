import { basename } from "node:path";

const separators = new Set([";", "&", "|", "\n", "(", ")", "`"]);
const wrappers = new Set(["sudo", "env", "command", "exec", "time", "nohup"]);
const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Splits a shell command line into simple commands, each a list of words with
 * quotes removed. Redirections (`> out`, `2>&1`, `<<EOF`) and their targets
 * are dropped: they are not arguments. Good enough to read intent, not a full shell parser.
 */
export function simpleCommands(line: string, limit = Infinity): string[][] {
	return split(line, limit)
		.filter((command) => limit !== Infinity || command.words.length > 0)
		.map((command) => command.words);
}

/** Like simpleCommands, with whether each command runs in a subshell: `( )`, `$( )` or backticks. */
export function commandsWithNesting(
	line: string,
): { words: string[]; nested: boolean }[] {
	return split(line)
		.filter((command) => command.words.length > 0)
		.map(({ words, scope }) => ({ words, nested: scope !== null }));
}

/**
 * Each command's words, and its words with the redirections kept: the operator
 * as a word of its own, then its target. `[commands] blocked` matches on these.
 */
export function commandsWithRedirections(line: string) {
	return split(line);
}

type Redirection = { operator: string; target: string };
type ShellScope = { parent: ShellScope | null };

function split(line: string, limit = Infinity) {
	const splitter = new Splitter();
	for (
		let index = 0;
		index < line.length && splitter.commands.length < limit;
		index++
	)
		index = splitter.read(line, index);
	splitter.endCommand();
	return splitter.commands;
}

// What may follow the first character of a redirection operator.
const operatorTail: Record<string, string[]> = {
	">": [">>", ">&", ">|", ">"],
	"<": ["<<<", "<<-", "<<", "<&", "<>", "<"],
	"&": ["&>>", "&>"],
};

class Splitter {
	commands: {
		words: string[];
		raw: string[];
		redirections: Redirection[];
		scope: ShellScope | null;
	}[] = [];
	private words: string[] = [];
	private raw: string[] = [];
	private redirections: Redirection[] = [];
	private word = "";
	private inWord = false;
	// The word has a quoted or escaped part, so it cannot be a file descriptor number.
	private literal = false;
	private operator: string | null = null;
	private scope: ShellScope | null = null;
	private inBacktick = false;

	read(line: string, index: number): number {
		const char = line[index] as string;
		if (char === "#" && !this.inWord) {
			const next = line.indexOf("\n", index);
			return next < 0 ? line.length : next - 1;
		}
		if (char === "'" || char === '"') {
			const quoted = readQuoted(line, index);
			this.add(quoted.text);
			this.literal = true;
			return quoted.end;
		}
		if (char === "\\" && index + 1 < line.length) {
			if (line[index + 1] !== "\n") {
				this.add(line[index + 1] as string);
				this.literal = true;
			}
			return index + 1;
		}
		if (char === "$" && line[index + 1] === "(") {
			this.endCommand();
			this.scope = { parent: this.scope };
			return index + 1;
		}
		const operator = (operatorTail[char] ?? []).find((text) =>
			line.startsWith(text, index),
		);
		if (operator) return this.redirect(operator, index);
		if (separators.has(char)) {
			this.endCommand();
			if (char === "(") this.scope = { parent: this.scope };
			else if (char === ")") this.scope = this.scope?.parent ?? null;
			else if (char === "`") {
				this.scope = this.inBacktick
					? (this.scope?.parent ?? null)
					: { parent: this.scope };
				this.inBacktick = !this.inBacktick;
			}
		} else if (char === " " || char === "\t") this.endWord();
		else this.add(char);
		return index;
	}

	/** An unquoted operator ends the word before it, unless that word is a file descriptor (`2>`). */
	private redirect(operator: string, index: number): number {
		let text = operator;
		if (this.inWord && !this.literal && /^\d+$/.test(this.word)) {
			text = this.word + operator;
			this.word = "";
			this.inWord = false;
		} else this.endWord();
		this.raw.push(text);
		this.operator = operator;
		return index + operator.length - 1;
	}

	endCommand() {
		this.endWord();
		if (this.raw.length > 0)
			this.commands.push({
				words: this.words,
				raw: this.raw,
				redirections: this.redirections,
				scope: this.scope,
			});
		this.words = [];
		this.raw = [];
		this.redirections = [];
		this.operator = null;
	}

	private endWord() {
		if (this.inWord) {
			this.raw.push(this.word);
			if (this.operator) {
				this.redirections.push({ operator: this.operator, target: this.word });
				this.operator = null;
			} else this.words.push(this.word);
		}
		this.word = "";
		this.inWord = false;
		this.literal = false;
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

/** Drops heredoc bodies: they are text fed to a command, not commands to run. */
export function withoutHeredocBodies(line: string): string {
	if (!line.includes("<<")) return line;
	const kept: string[] = [];
	let delimiter: string | null = null;
	for (const text of line.split("\n")) {
		if (delimiter !== null) {
			if (text.trim() === delimiter) delimiter = null;
			continue;
		}
		kept.push(text);
		if (text.includes("<<")) {
			const opened = split(text)
				.flatMap(({ redirections }) => redirections)
				.findLast(
					({ operator, target }) =>
						/^\d*<<-?$/.test(operator) && /^\w+$/.test(target),
				);
			if (opened) delimiter = opened.target;
		}
	}
	return kept.join("\n");
}

/** The program's name without its directory or .exe, so `/usr/bin/git` and `git.exe` are git. */
export const programName = (words: string[]) =>
	basename(words[0] ?? "").replace(/\.exe$/i, "");
