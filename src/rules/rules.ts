import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config/schema";
import { guardIds } from "../guards/catalog";
import { insideRoot, matchesGlob } from "../paths";
import { languages, loadParsers, parserForFile } from "./languages";
import { type LayoutRule, toLayoutRule } from "./layout";

export type Rule = {
	id: string;
	/** One or more keys of `languages`, in the order the rule file gives them. */
	languages: string[];
	message: string;
	instead: string;
	note: string | null;
	files: string[];
	ignores: string[];
	matcher: {
		rule: unknown;
		constraints?: unknown;
		utils?: unknown;
		transform?: unknown;
	};
	examples: { invalid: string[]; valid: string[] };
	source: string;
};

export type RuleFinding = {
	rule: string;
	path: string;
	line: number;
	column: number;
	message: string;
	instead: string;
};

export class RuleError extends Error {}

const allowedKeys = new Set([
	"id",
	"language",
	"rule",
	"constraints",
	"utils",
	"transform",
	"message",
	"instead",
	"note",
	"files",
	"ignores",
	"examples",
	"url",
	"metadata",
]);

export function ruleFiles(config: Config): string[] {
	const files: string[] = [];
	for (const dir of config.rules.dirs) {
		const absolute = join(config.root, dir);
		if (!existsSync(absolute)) continue;
		for (const file of new Bun.Glob("**/*.{yml,yaml}").scanSync({
			cwd: absolute,
		}))
			files.push(join(absolute, file));
	}
	return files.sort();
}

/** Both kinds of rule, from the same files. */
export type RuleSet = { code: Rule[]; layout: LayoutRule[] };

/**
 * Loads every rule file, or throws one error that lists every problem. A
 * document with a top-level `layout:` block is a layout rule; any other is a
 * code rule.
 */
export function loadRuleSet(config: Config): RuleSet {
	const problems: string[] = [];
	const code: Rule[] = [];
	const layout: LayoutRule[] = [];
	for (const file of ruleFiles(config)) {
		let parsed: unknown;
		try {
			parsed = Bun.YAML.parse(readFileSync(file, "utf8"));
		} catch (error) {
			problems.push(`${file}: not valid YAML (${(error as Error).message}).`);
			continue;
		}
		const docs = Array.isArray(parsed) ? parsed : [parsed];
		for (const doc of docs) {
			if (typeof doc === "object" && doc !== null && "layout" in doc) {
				const rule = toLayoutRule(
					doc as Record<string, unknown>,
					file,
					problems,
				);
				if (rule) layout.push(rule);
				continue;
			}
			const rule = toRule(doc, file, problems);
			if (rule) code.push(rule);
		}
	}
	const seen = new Map<string, string>();
	for (const rule of [...code, ...layout]) {
		if (guardIds.includes(rule.id))
			problems.push(
				`${rule.source}: id "${rule.id}" is a built-in guard. Pick another id.`,
			);
		const other = seen.get(rule.id);
		if (other)
			problems.push(
				`${rule.source}: id "${rule.id}" is also used in ${other}. Give each rule its own id.`,
			);
		seen.set(rule.id, rule.source);
	}
	if (problems.length > 0)
		throw new RuleError(
			`Rule files have problems:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
		);
	return { code, layout };
}

/** The code (ast-grep) rules, or throws one error that lists every problem in the rule files. */
export function loadRules(config: Config): Rule[] {
	return loadRuleSet(config).code;
}

/** The layout rules, or throws one error that lists every problem in the rule files. */
export function loadLayoutRules(config: Config): LayoutRule[] {
	return loadRuleSet(config).layout;
}

function toRule(doc: unknown, file: string, problems: string[]): Rule | null {
	if (typeof doc !== "object" || doc === null) {
		problems.push(
			`${file}: expected a rule (a YAML mapping), with "rule" for a code rule or "layout" for a layout rule.`,
		);
		return null;
	}
	const raw = doc as Record<string, unknown>;
	const where = `${file}${typeof raw.id === "string" ? ` (${raw.id})` : ""}`;
	const before = problems.length;
	for (const key of Object.keys(raw))
		if (!allowedKeys.has(key))
			problems.push(
				`${where}: "${key}" is not a rule key. Allowed: ${[...allowedKeys].join(", ")}.`,
			);
	for (const key of ["id", "message", "instead"])
		if (typeof raw[key] !== "string" || (raw[key] as string).trim() === "")
			problems.push(
				`${where}: "${key}" is required${key === "instead" ? ": say what to use instead, so the agent can fix it" : ""}.`,
			);
	const ruleLanguages = (
		typeof raw.language === "string"
			? [raw.language]
			: isStringList(raw.language)
				? raw.language
				: []
	).map((language) => language.toLowerCase());
	if (
		ruleLanguages.length === 0 ||
		ruleLanguages.some((language) => !(language in languages))
	)
		problems.push(
			`${where}: "language" must be one of ${Object.keys(languages).join(", ")}, or a list of them.`,
		);
	if (typeof raw.rule !== "object" || raw.rule === null)
		problems.push(
			`${where}: "rule" is required (an ast-grep rule, such as pattern: ...).`,
		);
	const examples = (raw.examples ?? {}) as Record<string, unknown>;
	for (const kind of ["invalid", "valid"])
		if (
			!isStringList(examples[kind]) ||
			(examples[kind] as string[]).length === 0
		)
			problems.push(
				`${where}: "examples.${kind}" needs at least one code example.`,
			);
	for (const key of ["files", "ignores"])
		if (raw[key] !== undefined && !isStringList(raw[key]))
			problems.push(`${where}: "${key}" must be a list of globs.`);
	if (problems.length > before) return null;
	return {
		id: raw.id as string,
		languages: [...new Set(ruleLanguages)],
		message: raw.message as string,
		instead: raw.instead as string,
		note: typeof raw.note === "string" ? raw.note : null,
		files: (raw.files as string[] | undefined) ?? [],
		ignores: (raw.ignores as string[] | undefined) ?? [],
		matcher: {
			rule: raw.rule,
			...(raw.constraints ? { constraints: raw.constraints } : {}),
			...(raw.utils ? { utils: raw.utils } : {}),
			...(raw.transform ? { transform: raw.transform } : {}),
		},
		examples: {
			invalid: examples.invalid as string[],
			valid: examples.valid as string[],
		},
		source: file,
	};
}

const isStringList = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((entry) => typeof entry === "string");

type Napi = Awaited<ReturnType<typeof loadParsers>>;

/** The parser a rule reads `file` with: the first of its languages that reads the extension. */
export function ruleParserForFile(rule: Rule, file: string) {
	for (const language of rule.languages) {
		const parser = parserForFile(language, file);
		if (parser) return parser;
	}
	return null;
}

/** Every parser a rule's languages use, each language's own parser first. */
function candidateParsers(rule: Rule) {
	const parsers = new Set<string>();
	for (const language of rule.languages) {
		const entry = languages[language];
		if (!entry) continue;
		parsers.add(entry.parser);
		for (const parser of Object.values(entry.extensions)) parsers.add(parser);
	}
	return [...parsers];
}

const compiled = new WeakMap<Rule, { parsers: string[]; problems: string[] }>();

/**
 * The parsers a rule's matcher compiles for. A kind that only one grammar has
 * (JSX kinds under `typescript`, which reads .ts without JSX) drops the parsers
 * that lack it, so the rule checks only the files where the kind can exist. A
 * language with no parser left is a problem with the rule file.
 */
function compile(napi: Napi, rules: Rule[]) {
	const problems: string[] = [];
	for (const rule of rules) {
		const known = compiled.get(rule);
		if (known) {
			problems.push(...known.problems);
			continue;
		}
		const ok: string[] = [];
		const ruleProblems: string[] = [];
		const errors = new Map<string, string>();
		for (const parser of candidateParsers(rule))
			try {
				napi
					.parse(parser as never, "")
					.root()
					.findAll(rule.matcher as never);
				ok.push(parser);
			} catch (error) {
				errors.set(parser, napiReason(error));
			}
		for (const language of rule.languages) {
			const entry = languages[language];
			if (!entry) continue;
			const parsers = new Set([
				entry.parser,
				...Object.values(entry.extensions),
			]);
			if ([...parsers].some((parser) => ok.includes(parser))) continue;
			ruleProblems.push(
				`${rule.source} (${rule.id}): the rule does not work for ${language}: ${errors.get(entry.parser) ?? "no parser"}.${rule.languages.length > 1 ? ` Drop ${language} from "language", or split the rule.` : ""}`,
			);
		}
		compiled.set(rule, { parsers: ok, problems: ruleProblems });
		problems.push(...ruleProblems);
	}
	if (problems.length > 0)
		throw new RuleError(
			`Rule files have problems:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
		);
}

/** ast-grep's error without its first line and arrows, on one line. */
function napiReason(error: unknown) {
	const lines = String((error as Error)?.message ?? error)
		.split("\n")
		.map((line) => line.replace(/^\s*\|->/, "").trim())
		.filter(Boolean);
	return (lines.length > 1 ? lines.slice(1) : lines)
		.map((line) => line.replace(/[.:]$/, ""))
		.join(": ");
}
type Match = { line: number; column: number; message: string };

function matches(
	napi: Napi,
	rule: Rule,
	parser: string,
	source: string,
): Match[] {
	const root = napi.parse(parser as never, source).root();
	return root.findAll(rule.matcher as never).map((node) => {
		const start = node.range().start;
		const message = rule.message.replace(
			/(\$\$\$|\$)([A-Z_][A-Z0-9_]*)/g,
			(text, sigil, name) => {
				if (sigil === "$") return node.getMatch(name)?.text() ?? text;
				const nodes = node.getMultipleMatches(name);
				const first = nodes[0];
				const last = nodes.at(-1);
				if (!first || !last) return "";
				return source.slice(first.range().start.index, last.range().end.index);
			},
		);
		return { line: start.line + 1, column: start.column + 1, message };
	});
}

function appliesTo(rule: Rule, path: string) {
	if (
		rule.files.length > 0 &&
		!rule.files.some((glob) => matchesGlob(glob, path))
	)
		return false;
	return !rule.ignores.some((glob) => matchesGlob(glob, path));
}

/** Findings in `files` (absolute), reported relative to the repo root. */
export async function findInFiles(
	rules: Rule[],
	files: string[],
	root: string,
): Promise<RuleFinding[]> {
	const work: { rule: Rule; path: string; file: string; parser: string }[] = [];
	for (const file of files) {
		const path = insideRoot(root, file);
		if (path === null || !existsSync(file)) continue;
		for (const rule of rules) {
			const parser = ruleParserForFile(rule, file);
			if (parser && appliesTo(rule, path))
				work.push({ rule, path, file, parser });
		}
	}
	if (work.length === 0) return [];
	const napi = await loadParsers(work.map((item) => item.parser));
	compile(napi, [...new Set(work.map((item) => item.rule))]);
	const sources = new Map<string, string>();
	const findings: RuleFinding[] = [];
	for (const { rule, path, file, parser } of work) {
		if (!compiled.get(rule)?.parsers.includes(parser)) continue;
		let source = sources.get(file);
		if (source === undefined) {
			source = readFileSync(file, "utf8");
			sources.set(file, source);
		}
		for (const match of matches(napi, rule, parser, source))
			findings.push({
				rule: rule.id,
				path,
				line: match.line,
				column: match.column,
				message: match.message,
				instead: rule.instead,
			});
	}
	return findings;
}

export function formatFinding(finding: RuleFinding) {
	return `${finding.path}:${finding.line}:${finding.column} ${finding.rule}: ${finding.message} Instead: ${finding.instead}`;
}

export type ExampleResult = {
	rule: string;
	kind: "invalid" | "valid";
	example: string;
	ok: boolean;
	matches: number;
};

/** Every invalid example must fire and every valid one must not. */
export async function testRules(rules: Rule[]): Promise<ExampleResult[]> {
	const napi = await loadParsers(rules.flatMap(candidateParsers));
	compile(napi, rules);
	const results: ExampleResult[] = [];
	for (const rule of rules) {
		// Examples are read as the first language, with the first parser the rule works in.
		const parser = compiled.get(rule)?.parsers[0] as string;
		for (const kind of ["invalid", "valid"] as const)
			for (const example of rule.examples[kind]) {
				const count = matches(napi, rule, parser, example).length;
				results.push({
					rule: rule.id,
					kind,
					example,
					matches: count,
					ok: kind === "invalid" ? count > 0 : count === 0,
				});
			}
	}
	return results;
}
