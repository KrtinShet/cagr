import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { Config } from "../config/schema";
import { insideRoot, matchesGlob } from "../paths";
import { run } from "../run";
import type { Finding } from "./finding";

const patterns = [
	{
		extensions: ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"],
		style: "slash",
		pattern:
			/(?:eslint-disable(?:-next-line|-line)?|@ts-ignore|@ts-nocheck|@ts-expect-error|biome-ignore|oxlint-disable(?:-next-line|-line)?|prettier-ignore)\b/,
	},
	{
		extensions: ["py", "pyi"],
		style: "hash",
		pattern:
			/#\s*(?:noqa\b|type:\s*ignore\b|pyright:\s*ignore\b|pylint:\s*disable\b|ruff:\s*noqa\b)/,
	},
	{
		extensions: ["go"],
		style: "slash",
		pattern: /\/\/\s*(?:nolint\b|lint:ignore\b)/,
	},
	{ extensions: ["rs"], style: "rust", pattern: /#!?\s*\[\s*allow\s*\(/ },
];

export const suppressionFix =
	"Fix the cause instead of silencing the linter. If the rule is wrong here, leave the code as is and tell the user which rule and why; a person adds the suppression.";
export type SuppressionFinding = Finding & { file: string; line: number };

/** Keep comments (or Rust code) and blank strings without changing line numbers. */
function visibleText(text: string, style: string): string {
	let result = "";
	let quote = "";
	let block = false;
	let line = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i] ?? "";
		const next = text[i + 1];
		if (line) {
			result += style === "rust" && c !== "\n" ? " " : c;
			if (c === "\n") line = false;
		} else if (block) {
			result += style === "rust" && c !== "\n" ? " " : c;
			if (c === "*" && next === "/") {
				result += style === "rust" ? " " : "/";
				i++;
				block = false;
			}
		} else if (quote) {
			if (c === "\\") {
				result += ` ${next === "\n" ? "\n" : " "}`;
				i++;
			} else if (text.startsWith(quote, i)) {
				result += " ".repeat(quote.length);
				i += quote.length - 1;
				quote = "";
			} else result += c === "\n" ? "\n" : " ";
		} else if (
			style === "rust" &&
			c === "'" &&
			!/^'(?:\\.|[^'\\\n])'/.test(text.slice(i))
		) {
			result += c;
		} else if (c === '"' || c === "'" || c === "`") {
			quote =
				style === "hash" && text.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
			result += " ".repeat(quote.length);
			i += quote.length - 1;
		} else if (style === "hash" ? c === "#" : c === "/" && next === "/") {
			line = true;
			result += style === "rust" ? " " : c;
		} else if (style !== "hash" && c === "/" && next === "*") {
			block = true;
			result += style === "rust" ? "  " : "/*";
			i++;
		} else result += c === "\n" || style === "rust" ? c : " ";
	}
	return result;
}

export function suppressionFindings(
	file: string,
	text: string,
	added: ReadonlySet<number>,
	config: Config,
): SuppressionFinding[] {
	if (
		!config.suppressions.enabled ||
		config.suppressions.allow.some((glob) => matchesGlob(glob, file))
	)
		return [];
	const language = patterns.find((entry) =>
		entry.extensions.includes(extname(file).slice(1)),
	);
	if (!language) return [];
	const lines = text.split("\n");
	return visibleText(text, language.style)
		.split("\n")
		.flatMap((line, index) =>
			added.has(index + 1) && language.pattern.test(line)
				? [
						{
							id: "lint-suppression",
							file,
							line: index + 1,
							reason: `${file}:${index + 1}: ${lines[index]?.trim()}\n${suppressionFix}`,
						},
					]
				: [],
		);
}

export function addedLines(patch: string): Set<number> {
	const lines = new Set<number>();
	for (const match of patch.matchAll(
		/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm,
	)) {
		const start = Number(match[1]);
		const count = match[2] === undefined ? 1 : Number(match[2]);
		for (let i = start; i < start + count; i++) lines.add(i);
	}
	return lines;
}

/** Hooks compare the worktree to HEAD; CI reads the committed branch, never formatter output. */
export async function checkSuppressions(
	config: Config,
	files: string[],
	base = "HEAD",
	head?: string,
): Promise<SuppressionFinding[]> {
	if (!config.suppressions.enabled) return [];
	const findings: SuppressionFinding[] = [];
	const deadline = performance.now() + (head ? 60_000 : 750);
	const git = async (args: string[]) => {
		const remaining = Math.floor(deadline - performance.now());
		if (remaining <= 0)
			throw new Error(
				"Suppression check exceeded its budget. Narrow the edited files and try again.",
			);
		const result = await run(["git", ...args], config.root, {
			timeoutMs: remaining,
		});
		if (!result.ok) throw new Error(result.output);
		return result.stdout;
	};
	let unborn = false;
	if (!head && base === "HEAD") {
		const ref = await run(
			["git", "rev-parse", "--verify", "--quiet", "HEAD"],
			config.root,
			{ timeoutMs: 100 },
		);
		if (!ref.ok) {
			await git(["rev-parse", "--is-inside-work-tree"]);
			if (ref.timedOut) throw new Error(ref.output);
			unborn = true;
		}
	}
	for (const absolute of files) {
		const file = insideRoot(config.root, absolute);
		if (
			!file ||
			!patterns.some((entry) =>
				entry.extensions.includes(extname(file).slice(1)),
			) ||
			config.suppressions.allow.some((glob) => matchesGlob(glob, file))
		)
			continue;
		const patch = unborn
			? ""
			: await git([
					"diff",
					"--no-ext-diff",
					"--no-textconv",
					"--no-renames",
					"--unified=0",
					base,
					...(head ? [head] : []),
					"--",
					file,
				]);
		const text = head
			? await git(["show", `${head}:${file}`])
			: readFileSync(join(config.root, file), "utf8");
		const added = addedLines(patch);
		if (
			!head &&
			!patch &&
			(unborn || (await git(["ls-files", "--others", "--", file])).length > 0)
		) {
			for (let i = 1; i <= text.split("\n").length; i++) added.add(i);
		}
		findings.push(...suppressionFindings(file, text, added, config));
	}
	return findings;
}
