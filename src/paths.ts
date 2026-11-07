import { basename, extname, isAbsolute, relative, sep } from "node:path";

const cache = new Map<string, Bun.Glob>();

/**
 * gitignore-style: a pattern without a slash matches the file name at any
 * depth; one with a slash matches the path from the repo root.
 */
export function matchesGlob(pattern: string, path: string): boolean {
	const anchored = pattern.replace(/^\//, "");
	const target = pattern.includes("/") ? toPosix(path) : basename(path);
	let glob = cache.get(anchored);
	if (!glob) {
		glob = new Bun.Glob(anchored);
		cache.set(anchored, glob);
	}
	return glob.match(target);
}

/** The path of `file` relative to `root`, or null when it is outside it. */
export function insideRoot(root: string, file: string): string | null {
	const rel = relative(root, file);
	if (
		rel === "" ||
		rel.startsWith(`..${sep}`) ||
		rel === ".." ||
		isAbsolute(rel)
	)
		return null;
	return toPosix(rel);
}

export function hasExtension(path: string, extensions: string[]) {
	return extensions.includes(extname(path).slice(1));
}

export function toPosix(path: string) {
	return sep === "/" ? path : path.split(sep).join("/");
}
