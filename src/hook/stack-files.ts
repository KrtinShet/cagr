import type { Config, Stack } from "../config/schema";
import { hasExtension, insideRoot, matchesGlob } from "../paths";
import { shellQuote } from "../run";

/** Repo-relative paths of `files` that `stack` covers. */
export function stackFiles(
	stack: Stack,
	files: string[],
	config: Config,
): string[] {
	const paths: string[] = [];
	for (const file of files) {
		const path = insideRoot(config.root, file);
		if (path === null) continue;
		if (stack.extensions.length > 0 && !hasExtension(path, stack.extensions))
			continue;
		if (stack.exclude_paths?.some((glob) => matchesGlob(glob, path))) continue;
		if (stack.paths.some((glob) => matchesGlob(glob, path))) paths.push(path);
	}
	return paths;
}

export function withFiles(command: string, paths: string[]) {
	return command.replaceAll("{files}", paths.map(shellQuote).join(" "));
}

const maxOutput = 4000;

/** Drops repeated lines and cuts long output, so the agent reads each problem once. */
export function tidy(output: string, limit = maxOutput) {
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const line of output.replace(/\r\n/g, "\n").trimEnd().split("\n")) {
		const key = line.trim();
		if (key !== "" && seen.has(key)) continue;
		seen.add(key);
		lines.push(line);
	}
	const text = lines.join("\n").replace(/\n{3,}/g, "\n\n");
	return text.length <= limit
		? text
		: `${text.slice(0, limit)}\n... (cut, run the check to see the rest)`;
}

const fileReference =
	/(?:^|[\s"'(])((?:[\w@.-]+\/)*[\w@.-]+\.[A-Za-z]\w*)(?=[:(]\d)/g;
const references = (line: string) =>
	[...line.matchAll(fileReference)].map((match) =>
		(match[1] as string).replace(/^\.\//, ""),
	);

/**
 * Keeps lines about changed files, and lines that name no file. A repo-wide
 * check such as `tsc` reports every error; the agent should see its own.
 * When every problem is elsewhere the output is kept, since the change may
 * have broken those files.
 */
export function focusOnChanged(output: string, changed: string[]) {
	const lines = output.split("\n");
	const kept = lines.filter((line) => {
		const refs = references(line);
		return (
			refs.length === 0 ||
			refs.some((ref) =>
				changed.some(
					(path) =>
						path === ref ||
						path.endsWith(`/${ref}`) ||
						ref.endsWith(`/${path}`),
				),
			)
		);
	});
	const hidden = lines.length - kept.length;
	const keptFindings = kept.some((line) => references(line).length > 0);
	if (hidden === 0 || !keptFindings) return output;
	return `${kept.join("\n")}\n(${hidden} line${hidden === 1 ? "" : "s"} about files you did not change hidden.)`;
}
