import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { emptyRecord, type ReviewRecord } from "./types";

/** Records live in the shared .git folder, so every worktree of the repo sees the same review. */
export function recordPath(commonDir: string, branch: string) {
	return join(
		commonDir,
		"guardwright",
		"reviews",
		`${branch.replace(/[^\w.-]/g, "__")}.json`,
	);
}

export function readRecord(file: string): ReviewRecord | null {
	if (!existsSync(file)) return null;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as ReviewRecord;
		return parsed.version === 1 ? parsed : null;
	} catch {
		return null;
	}
}

export function loadRecord(file: string, branch: string, base: string) {
	return readRecord(file) ?? emptyRecord(branch, base);
}

export function writeRecord(file: string, record: ReviewRecord) {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(record, null, "\t")}\n`);
}

export function allRecords(commonDir: string): ReviewRecord[] {
	const dir = join(commonDir, "guardwright", "reviews");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => readRecord(join(dir, name)))
		.filter((record): record is ReviewRecord => record !== null);
}
