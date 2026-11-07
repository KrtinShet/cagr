import { join, sep } from "node:path";
import type { Config } from "../config/schema";
import { insideRoot, matchesGlob } from "../paths";
import { commandReasons } from "./command";
import type { Finding } from "./finding";

export type EditContext = {
	/** The main checkout's folder when worktree_only is on, else null. */
	mainCheckout: string | null;
};

export function editFinding(
	file: string,
	config: Config,
	context: EditContext,
): Finding | null {
	const path = insideRoot(config.root, file);
	if (path !== null) {
		const entry = config.files.protected.find(
			(entry) =>
				matchesGlob(entry.glob, path) &&
				!entry.except.some((glob) => matchesGlob(glob, path)),
		);
		if (entry) return { id: "protected-file", reason: entry.reason };
	}
	const main = context.mainCheckout;
	if (
		main &&
		file.startsWith(`${main}${sep}`) &&
		!file.startsWith(`${join(main, config.git.worktree_dir)}${sep}`)
	)
		return {
			id: "worktree-only",
			reason: commandReasons.mainCheckout(config).replace("Work in", "Edit in"),
		};
	return null;
}
