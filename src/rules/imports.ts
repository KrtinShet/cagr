import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, posix } from "node:path";
import { matchesGlob, toPosix } from "../paths";

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

/** JSON with comments and trailing commas, as tsconfig allows. */
function parseJsonc(text: string): unknown {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (char === '"') {
			const start = i;
			for (i++; i < text.length && text[i] !== '"'; i++)
				if (text[i] === "\\") i++;
			out += text.slice(start, i + 1);
		} else if (char === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			out += "\n";
		} else if (char === "/" && text[i + 1] === "*") {
			i = text.indexOf("*/", i + 2);
			if (i === -1) break;
			i++;
		} else out += char;
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
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
	let raw: { extends?: unknown; compilerOptions?: CompilerOptions };
	try {
		raw = parseJsonc(readFileSync(file, "utf8")) as typeof raw;
	} catch {
		return {};
	}
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
	const own = raw.compilerOptions ?? {};
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

function relativeTo(root: string, absolute: string) {
	const rel = toPosix(absolute.slice(normalize(root).length)).replace(
		/^\/+/,
		"",
	);
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
		let best: { prefix: number; targets: string[]; rest: string } | null = null;
		for (const [pattern, targets] of config.paths) {
			const star = pattern.indexOf("*");
			if (star === -1) {
				if (pattern === specifier && (!best || pattern.length > best.prefix))
					best = { prefix: pattern.length, targets, rest: "" };
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
			return found ?? (candidates[0] as string);
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
		boundary.forbid.some((glob) => matchesGlob(glob, target)) &&
		!boundary.allow.some((glob) => matchesGlob(glob, target))
	);
}

/** The text of a source node without its quotes. */
export function unquote(text: string) {
	return text.slice(1, -1);
}

/** Forget cached tsconfig reads, for tests that rewrite them. */
export function clearImportCache() {
	configCache.clear();
}
