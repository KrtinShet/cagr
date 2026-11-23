import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config/schema";
import { insideRoot, matchesGlob } from "../paths";
import { stateFile } from "../turn-state";

export async function serialNotice(
	config: Config,
	session: string,
	files: string[],
) {
	if (!config.lease.length) return "";
	const paths = files.map((file) => insideRoot(config.root, file));
	const matches = config.lease.filter((lease) =>
		lease.paths.some((glob) =>
			paths.some((path) => path !== null && matchesGlob(glob, path)),
		),
	);
	if (!matches.length) return "";
	const repo = createHash("sha256").update(config.root).digest("hex");
	const directory = join(`${stateFile(session)}.leases`, repo);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const notes = [];
	for (const { name } of matches) {
		try {
			await writeFile(join(directory, name), "", { flag: "wx" });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
			throw error;
		}
		const branch = config.git.protected_branch
			? `origin/${config.git.protected_branch}`
			: "origin's default branch";
		notes.push(
			`serial: ${name} is numbered at landing. Take the lease before pushing (\`cagr lease take ${name}\`), then merge ${branch} so your number follows its tip.`,
		);
	}
	return notes.join("\n");
}
