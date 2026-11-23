import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tryLock } from "../lock";
import { emptyRecord, type ReviewRecord } from "./types";

/** Records live in the shared .git folder, so every worktree of the repo sees the same review. */
export function recordPath(
	commonDir: string,
	branch: string,
	directory: "reviews" | "ci-reviews" = "reviews",
) {
	// The legacy sanitizer could never write a name containing "%".
	return join(
		commonDir,
		"cagr",
		directory,
		`%${createHash("sha256").update(branch).digest("hex")}.json`,
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

export function readBranchRecord(file: string, branch: string) {
	const current = readRecord(file);
	if (current?.branch === branch) return current;
	const legacy = readRecord(
		join(dirname(file), `${branch.replace(/[^\w.-]/g, "__")}.json`),
	);
	return legacy?.branch === branch ? legacy : null;
}

export function loadRecord(file: string, branch: string, base: string) {
	return readBranchRecord(file, branch) ?? emptyRecord(branch, base);
}

export function writeRecord(file: string, record: ReviewRecord) {
	mkdirSync(dirname(file), { recursive: true });
	const pending = `${file}.${process.pid}.tmp`;
	try {
		writeFileSync(pending, `${JSON.stringify(record, null, "\t")}\n`);
		renameSync(pending, file);
	} finally {
		rmSync(pending, { force: true });
	}
}

export class ReviewRecordBusy extends Error {}

export async function withReviewLock<T>(
	file: string | null,
	action: () => T | Promise<T>,
): Promise<T> {
	if (!file) return action();
	mkdirSync(dirname(file), { recursive: true });
	const lock = tryLock(`${file}.lock`);
	if (!lock)
		throw new ReviewRecordBusy(
			"A review or answer is already running on this branch. Wait for it to finish, then try again.",
		);
	try {
		return await action();
	} finally {
		lock.close();
	}
}

export function allRecords(commonDir: string): ReviewRecord[] {
	const dir = join(commonDir, "cagr", "reviews");
	if (!existsSync(dir)) return [];
	const byBranch = new Map<string, ReviewRecord>();
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json")) continue;
		const file = join(dir, name);
		const record = readRecord(file);
		if (
			record &&
			(!byBranch.has(record.branch) ||
				file === recordPath(commonDir, record.branch))
		)
			byBranch.set(record.branch, record);
	}
	return [...byBranch.values()];
}
