import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, posix, relative } from "node:path";
import { toPosix } from "../paths";
import { RuleError } from "./rule-error";

/** An `imports:` block: the modules a rule's files may not import, by resolved path. */
export type ImportBoundary = { forbid: string[]; allow: string[] };

/** The languages an `imports:` rule can check, and the default when it names none. */
export const importLanguages = ["typescript", "tsx", "javascript"];

/**
 * Module sources: `import ... from`, `export ... from`, `import()` and
 * `require()` with a plain string. `$SRC` is the source with its quotes.
 */
export const importMatcher = {
	rule: {
		pattern: "$SRC",
		all: [
			{ any: [{ kind: "string" }, { kind: "template_string" }] },
			{ not: { has: { kind: "template_substitution" } } },
			{
				any: [
					{ inside: { kind: "import_statement", field: "source" } },
					{ inside: { kind: "export_statement", field: "source" } },
					{
						nthChild: 1,
						inside: {
							kind: "arguments",
							inside: {
								kind: "call_expression",
								has: { field: "function", regex: "^(require|import)$" },
							},
						},
					},
				],
			},
		],
	},
};

const moduleExtensions = [
	".ts",
	".tsx",
	".mts",
	".cts",
	".d.ts",
	".js",
	".jsx",
	".mjs",
	".cjs",
];

type PathsConfig = {
	/** Repo-relative directory that `paths` targets are relative to. */
	base: string;
	paths: [string, string[]][];
	/** Repo-relative baseUrl, when the config sets one. */
	baseUrl: string | null;
};

// Absolute directory to the nearest config's paths, for one process.
const configCache = new Map<string, PathsConfig | null>();

/** Calls `each` for every character outside a JSON string, and copies strings through. */
function outsideStrings(
	text: string,
	each: (text: string, i: number) => { emit: string; next: number },
) {
	let out = "";
	for (let i = 0; i < text.length; ) {
		if (text[i] === '"') {
			let end = i + 1;
			while (end < text.length && text[end] !== '"')
				end += text[end] === "\\" ? 2 : 1;
			out += text.slice(i, end + 1);
			i = end + 1;
			continue;
		}
		const step = each(text, i);
		out += step.emit;
		i = step.next;
	}
	return out;
}

/** JSON with comments, trailing commas and a byte order mark, as tsconfig allows. */
export function parseJsonc(text: string): unknown {
	const noComments = outsideStrings(text.replace(/^\uFEFF/, ""), (t, i) => {
		if (t.startsWith("//", i)) {
			const end = t.indexOf("\n", i);
			return { emit: "\n", next: end === -1 ? t.length : end };
		}
		if (t.startsWith("/*", i)) {
			const end = t.indexOf("*/", i + 2);
			return { emit: " ", next: end === -1 ? t.length : end + 2 };
		}
		return { emit: t[i] as string, next: i + 1 };
	});
	const noTrailingCommas = outsideStrings(noComments, (t, i) => {
		if (t[i] === "," && /^\s*[}\]]/.test(t.slice(i + 1)))
			return { emit: "", next: i + 1 };
		return { emit: t[i] as string, next: i + 1 };
	});
	return JSON.parse(noTrailingCommas);
}

type CompilerOptions = {
	paths?: Record<string, string[]>;
	baseUrl?: string;
};

/** compilerOptions.paths and baseUrl, each with the directory of the file that set it. Follows relative `extends`. */
function readOptions(
	file: string,
	seen = new Set<string>(),
): { paths?: [Record<string, string[]>, string]; baseUrl?: string } {
	if (seen.has(file) || !existsSync(file)) return {};
	seen.add(file);
	let parsed: unknown;
	try {
		parsed = parseJsonc(readFileSync(file, "utf8"));
	} catch (error) {
		// Without its paths, alias imports would pass every boundary unchecked.
		throw new RuleError(
			`Import rules cannot read ${file}: ${(error as Error).message}. Fix the file so its paths can be resolved.`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		throw new RuleError(
			`Import rules cannot read ${file}: it is not a JSON object. Fix the file so its paths can be resolved.`,
		);
	const raw = parsed as {
		extends?: unknown;
		compilerOptions?: CompilerOptions;
	};
	const dir = dirname(file);
	const parents = (
		Array.isArray(raw.extends) ? raw.extends : [raw.extends]
	).filter(
		(entry): entry is string =>
			typeof entry === "string" && entry.startsWith("."),
	);
	let options: ReturnType<typeof readOptions> = {};
	for (const parent of parents) {
		const path = join(dir, parent);
		options = {
			...options,
			...readOptions(path.endsWith(".json") ? path : `${path}.json`, seen),
		};
	}
	const own =
		typeof raw.compilerOptions === "object" && raw.compilerOptions !== null
			? raw.compilerOptions
			: {};
	if (own.paths && typeof own.paths === "object")
		options.paths = [own.paths, dir];
	if (typeof own.baseUrl === "string") options.baseUrl = join(dir, own.baseUrl);
	return options;
}

/** The nearest tsconfig.json or jsconfig.json at or above `dir`, inside `root`. */
function pathsConfig(root: string, dir: string): PathsConfig | null {
	const cached = configCache.get(dir);
	if (cached !== undefined) return cached;
	let result: PathsConfig | null = null;
	const file = ["tsconfig.json", "jsconfig.json"]
		.map((name) => join(dir, name))
		.find((path) => existsSync(path));
	if (file) {
		const options = readOptions(file);
		const baseUrl = options.baseUrl ?? null;
		const pathsDir = options.paths ? (baseUrl ?? options.paths[1]) : root;
		result = {
			base: relativeTo(root, pathsDir),
			paths: Object.entries(options.paths?.[0] ?? {}).filter(
				(entry): entry is [string, string[]] =>
					Array.isArray(entry[1]) &&
					entry[1].every((target) => typeof target === "string"),
			),
			baseUrl: baseUrl === null ? null : relativeTo(root, baseUrl),
		};
	} else if (normalize(dir) !== normalize(root) && dir !== dirname(dir))
		result = pathsConfig(root, dirname(dir));
	configCache.set(dir, result);
	return result;
}

/** Repo-relative, or starting with ../ when the directory is outside the repo. */
function relativeTo(root: string, absolute: string) {
	const rel = toPosix(relative(root, absolute));
	return rel === "" ? "." : rel;
}

/** The module file a repo-relative path names, trying extensions and index files, or the path itself. */
function probe(root: string, path: string) {
	const isFile = (candidate: string) => {
		try {
			return statSync(join(root, candidate)).isFile();
		} catch {
			return false;
		}
	};
	if (isFile(path)) return path;
	const stems = [path];
	// TypeScript lets "./x.js" name x.ts.
	const js = path.match(/^(.*)\.(js|jsx|mjs|cjs)$/);
	if (js?.[1]) stems.push(js[1]);
	for (const stem of stems)
		for (const extension of moduleExtensions)
			if (isFile(`${stem}${extension}`)) return `${stem}${extension}`;
	for (const extension of moduleExtensions)
		if (isFile(`${path}/index${extension}`)) return `${path}/index${extension}`;
	return path;
}

/**
 * Where an import source points, as a repo-relative path: relative sources
 * from the importing file, aliases from the nearest tsconfig.json or
 * jsconfig.json `paths` (and `baseUrl`). A package name stays as written.
 * When the module exists, the path names its file, such as src/a/index.ts.
 */
export function resolveImport(
	root: string,
	from: string | null,
	specifier: string,
): string {
	const fromDir = from === null ? "." : posix.dirname(from);
	if (
		specifier.startsWith("./") ||
		specifier.startsWith("../") ||
		specifier === "." ||
		specifier === ".."
	)
		return probe(root, posix.normalize(posix.join(fromDir, specifier)));
	const config = pathsConfig(root, join(root, fromDir));
	if (config) {
		let best: {
			prefix: number;
			targets: string[];
			rest: string;
			catchAll: boolean;
		} | null = null;
		for (const [pattern, targets] of config.paths) {
			const star = pattern.indexOf("*");
			if (star === -1) {
				if (pattern === specifier && (!best || pattern.length > best.prefix))
					best = { prefix: pattern.length, targets, rest: "", catchAll: false };
				continue;
			}
			const prefix = pattern.slice(0, star);
			const suffix = pattern.slice(star + 1);
			if (
				specifier.startsWith(prefix) &&
				specifier.endsWith(suffix) &&
				specifier.length >= prefix.length + suffix.length &&
				(!best || prefix.length > best.prefix)
			)
				best = {
					prefix: prefix.length,
					targets,
					catchAll: pattern === "*",
					rest: specifier.slice(
						prefix.length,
						specifier.length - suffix.length,
					),
				};
		}
		if (best) {
			const candidates = best.targets.map((target) =>
				posix.normalize(
					posix.join(config.base, target.replace("*", best.rest)),
				),
			);
			const found = candidates
				.map((candidate) => probe(root, candidate))
				.find(
					(path, i) => path !== candidates[i] || existsSync(join(root, path)),
				);
			// A catch-all "*" (often for local type shims) falls back to the package, as TypeScript does.
			if (found) return found;
			return best.catchAll ? specifier : (candidates[0] as string);
		}
		if (config.baseUrl !== null) {
			const candidate = posix.normalize(posix.join(config.baseUrl, specifier));
			const found = probe(root, candidate);
			if (found !== candidate || existsSync(join(root, candidate)))
				return found;
		}
	}
	return specifier;
}

/** True when `target` is one of the boundary's forbidden modules. */
export function crosses(boundary: ImportBoundary, target: string) {
	return (
		boundary.forbid.some((glob) => matchesTarget(glob, target)) &&
		!boundary.allow.some((glob) => matchesTarget(glob, target))
	);
}

const globs = new Map<string, Bun.Glob>();

/** The whole target against the whole glob: "swr" is the swr package, not any path ending in swr. */
function matchesTarget(pattern: string, target: string) {
	let glob = globs.get(pattern);
	if (!glob) {
		glob = new Bun.Glob(pattern);
		globs.set(pattern, glob);
	}
	return glob.match(target);
}

/** The text of a source node without its quotes. */
export function unquote(text: string) {
	return text.slice(1, -1);
}

/** Forget cached tsconfig reads, for tests that rewrite them. */
export function clearImportCache() {
	configCache.clear();
}
