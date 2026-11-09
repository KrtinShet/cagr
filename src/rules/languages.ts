import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { version } from "../version";

type Language = { parser: string; extensions: Record<string, string> };

/** Rule languages, and which parser reads each file extension. */
export const languages: Record<string, Language> = {
	typescript: {
		parser: "TypeScript",
		extensions: {
			ts: "TypeScript",
			mts: "TypeScript",
			cts: "TypeScript",
			tsx: "Tsx",
		},
	},
	tsx: { parser: "Tsx", extensions: { tsx: "Tsx" } },
	javascript: {
		parser: "JavaScript",
		extensions: {
			js: "JavaScript",
			mjs: "JavaScript",
			cjs: "JavaScript",
			jsx: "JavaScript",
		},
	},
	html: { parser: "Html", extensions: { html: "Html", htm: "Html" } },
	css: { parser: "Css", extensions: { css: "Css" } },
	python: { parser: "python", extensions: { py: "python", pyi: "python" } },
	go: { parser: "go", extensions: { go: "go" } },
	rust: { parser: "rust", extensions: { rs: "rust" } },
};

/** Parsers napi does not build in. Each ships as a tree-sitter library per platform. */
export const dynamicParsers = ["python", "go", "rust"] as const;
type DynamicParser = (typeof dynamicParsers)[number];

const symbols: Record<DynamicParser, string> = {
	python: "tree_sitter_python",
	go: "tree_sitter_go",
	rust: "tree_sitter_rust",
};

// Set by the compiled binary's entry point: parser name to its embedded file.
let embedded: Partial<Record<DynamicParser, string>> = {};
export function setEmbeddedParsers(
	files: Partial<Record<DynamicParser, string>>,
) {
	embedded = files;
}

export function parserForFile(language: string, file: string) {
	if (!Object.hasOwn(languages, language)) return null;
	return languages[language]?.extensions[extname(file).slice(1)] ?? null;
}

export function prebuildDir(platform = process.platform, arch = process.arch) {
	const os = { darwin: "macOS", linux: "Linux", win32: "Windows" }[
		platform as string
	];
	const cpu = { arm64: "ARM64", x64: "X64" }[arch as string];
	return os && cpu ? `prebuild-${os}-${cpu}` : null;
}

function cacheDir() {
	const base =
		process.env.XDG_CACHE_HOME ??
		(process.platform === "win32"
			? (process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"))
			: join(homedir(), ".cache"));
	return join(base, "cagr", version);
}

async function libraryPath(parser: DynamicParser): Promise<string | null> {
	const file = embedded[parser];
	if (file) {
		// dlopen needs a real file, so the embedded copy is written out once per version.
		const target = join(
			cacheDir(),
			`${parser}-${process.platform}-${process.arch}.so`,
		);
		if (!existsSync(target)) {
			mkdirSync(dirname(target), { recursive: true });
			const temp = `${target}.${process.pid}.tmp`;
			writeFileSync(temp, new Uint8Array(await Bun.file(file).arrayBuffer()));
			renameSync(temp, target);
		}
		return target;
	}
	const dir = prebuildDir();
	if (!dir) return null;
	try {
		const pkg = Bun.resolveSync(
			`@ast-grep/lang-${parser}/package.json`,
			import.meta.dir,
		);
		const path = join(dirname(pkg), "prebuilds", dir, "parser.so");
		return existsSync(path) ? path : null;
	} catch {
		return null;
	}
}

const registered = new Set<string>();

/** Loads napi and registers the dynamic parsers in `needed`. Returns the napi module. */
export async function loadParsers(needed: Iterable<string>) {
	const napi = await import("@ast-grep/napi");
	const missing = [...new Set(needed)].filter(
		(parser): parser is DynamicParser =>
			(dynamicParsers as readonly string[]).includes(parser) &&
			!registered.has(parser),
	);
	const toRegister: Record<
		string,
		{
			libraryPath: string;
			extensions: string[];
			languageSymbol: string;
			expandoChar: string;
		}
	> = {};
	for (const parser of missing) {
		const path = await libraryPath(parser);
		if (!path)
			throw new Error(
				`No ${parser} parser for ${process.platform}-${process.arch}.`,
			);
		toRegister[parser] = {
			libraryPath: path,
			extensions: Object.keys(languages[parser]?.extensions ?? {}),
			languageSymbol: symbols[parser],
			expandoChar: "µ",
		};
		registered.add(parser);
	}
	if (Object.keys(toRegister).length > 0)
		napi.registerDynamicLanguage(toRegister);
	return napi;
}
