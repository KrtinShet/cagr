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
	examples: { invalid: CodeExample[]; valid: CodeExample[] };
	source: string;
};

/** A snippet the rule is tested on. With a path, `files`, `ignores` and the path's parser apply. */
export type CodeExample = { code: string; path: string | null };

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
 * document with a top-level `layout:` block is a layout rule, one with only
 * `utils:` holds utility rules any code rule may use, and any other is a code
 * rule.
 */
export function loadRuleSet(config: Config): RuleSet {
	const problems: string[] = [];
	const code: Rule[] = [];
	const layout: LayoutRule[] = [];
	const shared = new Map<string, { rule: unknown; source: string }>();
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
			if (isUtilsOnly(doc)) {
				addShared(doc.utils, file, shared, problems);
				continue;
			}
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
	for (const rule of code) withShared(rule, shared);
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

const isUtilsOnly = (doc: unknown): doc is { utils: unknown } =>
	typeof doc === "object" &&
	doc !== null &&
	!Array.isArray(doc) &&
	Object.keys(doc).length === 1 &&
	"utils" in doc;

function addShared(
	utils: unknown,
	file: string,
	shared: Map<string, { rule: unknown; source: string }>,
	problems: string[],
) {
	if (typeof utils !== "object" || utils === null || Array.isArray(utils)) {
		problems.push(
			`${file}: "utils" must map each utility name to an ast-grep rule.`,
		);
		return;
	}
	for (const [name, rule] of Object.entries(utils)) {
		const other = shared.get(name);
		if (other)
			problems.push(
				`${file}: shared util "${name}" is also defined in ${other.source}. Give each shared util its own name.`,
			);
		else if (typeof rule !== "object" || rule === null)
			problems.push(
				`${file}: shared util "${name}" must be an ast-grep rule, such as kind: string.`,
			);
		else shared.set(name, { rule, source: file });
	}
}

/** Names a matcher refers to with `matches:`, anywhere inside it. */
function referencedUtils(value: unknown, found = new Set<string>()) {
	if (Array.isArray(value))
		for (const entry of value) referencedUtils(entry, found);
	else if (typeof value === "object" && value !== null)
		for (const [key, entry] of Object.entries(value)) {
			if (key === "matches" && typeof entry === "string") found.add(entry);
			else referencedUtils(entry, found);
		}
	return found;
}

/**
 * Adds the shared utils a rule uses, and the ones those use, to its own. Only
 * the used ones: a shared util with JSX kinds would otherwise stop every
 * TypeScript rule from compiling for .ts files. A rule's own util of the same
 * name wins.
 */
function withShared(
	rule: Rule,
	shared: Map<string, { rule: unknown; source: string }>,
) {
	if (shared.size === 0) return;
	const own = (rule.matcher.utils ?? {}) as Record<string, unknown>;
	const added: Record<string, unknown> = {};
	const pending = [...referencedUtils(rule.matcher)];
	while (pending.length > 0) {
		const name = pending.pop() as string;
		if (name in own || name in added) continue;
		const util = shared.get(name);
		if (!util) continue;
		added[name] = util.rule;
		pending.push(...referencedUtils(util.rule));
	}
	if (Object.keys(added).length > 0) rule.matcher.utils = { ...added, ...own };
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
		ruleLanguages.some((language) => !Object.hasOwn(languages, language))
	)
		problems.push(
			`${where}: "language" must be one of ${Object.keys(languages).join(", ")}, or a list of them.`,
		);
	if (typeof raw.rule !== "object" || raw.rule === null)
		problems.push(
			`${where}: "rule" is required (an ast-grep rule, such as pattern: ...).`,
		);
	const rawExamples = (raw.examples ?? {}) as Record<string, unknown>;
	const examples = { invalid: [] as CodeExample[], valid: [] as CodeExample[] };
	for (const kind of ["invalid", "valid"] as const) {
		const list = rawExamples[kind];
		if (!Array.isArray(list) || list.length === 0) {
			problems.push(
				`${where}: "examples.${kind}" needs at least one code example.`,
			);
			continue;
		}
		for (const entry of list) {
			const example = toExample(entry, ruleLanguages);
			if (typeof example === "string")
				problems.push(`${where}: "examples.${kind}" ${example}`);
			else examples[kind].push(example);
		}
	}
	for (const key of ["utils", "constraints", "transform"])
		if (
			raw[key] !== undefined &&
			(typeof raw[key] !== "object" ||
				raw[key] === null ||
				Array.isArray(raw[key]))
		)
			problems.push(
				`${where}: "${key}" must be a mapping of names to ast-grep rules. To use a shared util, write matches: <name> in "rule".`,
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
		examples,
		source: file,
	};
}

/** One example, or what is wrong with it. */
function toExample(
	entry: unknown,
	ruleLanguages: string[],
): CodeExample | string {
	if (typeof entry === "string") return { code: entry, path: null };
	const shape =
		"entries are code, or a mapping with path (repo-relative) and code.";
	if (typeof entry !== "object" || entry === null || Array.isArray(entry))
		return shape;
	const { path, code, ...rest } = entry as Record<string, unknown>;
	const extra = Object.keys(rest);
	if (extra.length > 0) return `has "${extra[0]}": ${shape}`;
	if (typeof path !== "string" || path === "" || typeof code !== "string")
		return shape;
	if (
		path.startsWith("/") ||
		path.includes("\\") ||
		/^[A-Za-z]:/.test(path) ||
		path.split("/").some((part) => part === "" || part === "." || part === "..")
	)
		return `path ${path} is not repo-relative, so files and ignores could never match it. Write it from the repo root with forward slashes, such as apps/web/src/a.ts.`;
	if (
		ruleLanguages.length > 0 &&
		!ruleLanguages.some((language) => parserForFile(language, path))
	)
		return `path ${path}: no language of this rule reads that extension. Use a path its language reads, such as a .${Object.keys(languages[ruleLanguages[0] as string]?.extensions ?? {})[0] ?? "ts"} file.`;
	return { code, path };
}

const isStringList = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((entry) => typeof entry === "string");

type Napi = Awaited<ReturnType<typeof loadParsers>>;

/** The language and parser a rule reads `file` with: the first of its languages that reads the extension. */
export function ruleParserForFile(rule: Rule, file: string) {
	for (const language of rule.languages) {
		const parser = parserForFile(language, file);
		if (parser) return { language, parser };
	}
	return null;
}

/** A language's own parser first, then the ones its extensions use. */
function languageParsers(language: string) {
	const entry = languages[language];
	if (!entry) return [];
	return [...new Set([entry.parser, ...Object.values(entry.extensions)])];
}

/** Every parser a rule's languages use, each language's own parser first. */
function candidateParsers(rule: Rule) {
	return [...new Set(rule.languages.flatMap(languageParsers))];
}

// Per rule, per parser: null when the matcher compiles, else ast-grep's reason.
const compiled = new WeakMap<Rule, Map<string, string | null>>();

function works(rule: Rule, parser: string) {
	return compiled.get(rule)?.get(parser) === null;
}

/**
 * Compiles each rule for every parser of the given languages, which must be
 * loaded. A kind that only one grammar has (JSX kinds under `typescript`, which
 * reads .ts without JSX) drops the parsers that lack it, so the rule checks
 * only the files where the kind can exist. A language with no parser left is a
 * problem with the rule file.
 */
function compile(napi: Napi, wanted: Map<Rule, Set<string>>) {
	const problems: string[] = [];
	for (const [rule, ruleLanguages] of wanted) {
		let results = compiled.get(rule);
		if (!results) {
			results = new Map();
			compiled.set(rule, results);
		}
		for (const language of ruleLanguages) {
			const parsers = languageParsers(language);
			for (const parser of parsers) {
				if (results.has(parser)) continue;
				try {
					napi
						.parse(parser as never, "")
						.root()
						.findAll(rule.matcher as never);
					results.set(parser, null);
				} catch (error) {
					results.set(parser, napiReason(error));
				}
			}
			if (parsers.some((parser) => works(rule, parser))) continue;
			problems.push(
				`${rule.source} (${rule.id}): the rule does not work for ${language}: ${results.get(parsers[0] as string) ?? "no parser"}. ${rule.languages.length > 1 ? `Fix the rule, or drop ${language} from "language"` : "Fix the kind or regex in its rule"}, then run \`cagr rules test\`.`,
			);
		}
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
	const wanted = new Map<Rule, Set<string>>();
	for (const file of files) {
		const path = insideRoot(root, file);
		if (path === null || !existsSync(file)) continue;
		for (const rule of rules) {
			const read = ruleParserForFile(rule, file);
			if (!read || !appliesTo(rule, path)) continue;
			work.push({ rule, path, file, parser: read.parser });
			wanted.set(rule, (wanted.get(rule) ?? new Set()).add(read.language));
		}
	}
	if (work.length === 0) return [];
	// Only the languages of these files, so no other dynamic parser gets loaded.
	const napi = await loadParsers(
		[...wanted.values()].flatMap((set) => [...set].flatMap(languageParsers)),
	);
	compile(napi, wanted);
	const sources = new Map<string, string>();
	const findings: RuleFinding[] = [];
	for (const { rule, path, file, parser } of work) {
		if (!works(rule, parser)) continue;
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
	/** The repo-relative path a code example is tested at, when it gives one. */
	path?: string;
	/** Why the rule did not run on the example, when it did not. */
	skipped?: string;
	ok: boolean;
	matches: number;
};

/** Every invalid example must fire and every valid one must not. */
export async function testRules(rules: Rule[]): Promise<ExampleResult[]> {
	const napi = await loadParsers(rules.flatMap(candidateParsers));
	compile(napi, new Map(rules.map((rule) => [rule, new Set(rule.languages)])));
	const results: ExampleResult[] = [];
	for (const rule of rules) {
		const parsers = candidateParsers(rule).filter((p) => works(rule, p));
		for (const kind of ["invalid", "valid"] as const)
			for (const { code, path } of rule.examples[kind]) {
				// Without a path, an example is read with the first parser the rule works in.
				// With one, it runs as the rule would run on that file, or not at all.
				const parser = path
					? ruleParserForFile(rule, path)?.parser
					: parsers[0];
				const skipped = !parser
					? "no language of the rule reads it"
					: !parsers.includes(parser)
						? `the rule's kinds do not exist in the ${parser} parser, so it does not run on this file`
						: path !== null && !appliesTo(rule, path)
							? rule.ignores.some((glob) => matchesGlob(glob, path))
								? "the path matches ignores, so the rule does not run on it"
								: "the path is not in files, so the rule does not run on it"
							: null;
				const count =
					parser && skipped === null
						? matches(napi, rule, parser, code).length
						: 0;
				results.push({
					rule: rule.id,
					kind,
					example: code,
					...(path ? { path } : {}),
					...(skipped ? { skipped } : {}),
					matches: count,
					ok: kind === "invalid" ? count > 0 : count === 0,
				});
			}
	}
	return results;
}
