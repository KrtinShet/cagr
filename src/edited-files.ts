import { isAbsolute, resolve } from "node:path";

const patchFileLine = /^\*\*\* (?:Add File|Update File|Move to): (.+)$/gm;

/**
 * Absolute paths of the files a tool call wrote. Claude Code sends
 * `file_path` (or `notebook_path`); Codex sends an apply_patch body in `command`,
 * as a string or as the argv `["apply_patch", body]`.
 */
export function editedFiles(toolInput: unknown, cwd: string): string[] {
	if (typeof toolInput !== "object" || toolInput === null) return [];
	const input = toolInput as Record<string, unknown>;
	const paths: string[] = [];
	if (typeof input.file_path === "string") paths.push(input.file_path);
	if (typeof input.notebook_path === "string") paths.push(input.notebook_path);
	const patches =
		typeof input.command === "string"
			? [input.command]
			: Array.isArray(input.command)
				? input.command
				: [];
	if (typeof input.patch === "string") patches.push(input.patch);
	for (const patch of patches) {
		if (typeof patch !== "string") continue;
		for (const match of patch.matchAll(patchFileLine))
			paths.push((match[1] as string).trim());
	}
	const absolute = paths.map((path) =>
		isAbsolute(path) ? path : resolve(cwd, path),
	);
	return [...new Set(absolute)];
}
