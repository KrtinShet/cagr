import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Timing = { event: string; check: string; ms: number; at: string };

// One file per repo, so doctor reports only this repo's hooks.
const file = (root: string) =>
	join(tmpdir(), "cagr", `timings-${Bun.hash(root).toString(36)}.json`);
const keep = 200;

export function readTimings(root: string): Timing[] {
	try {
		return JSON.parse(readFileSync(file(root), "utf8")) as Timing[];
	} catch {
		return [];
	}
}

/** Best effort: a hook never fails because its timing could not be saved. */
export function recordTimings(root: string, entries: Omit<Timing, "at">[]) {
	if (entries.length === 0) return;
	try {
		const at = new Date().toISOString();
		const all = [
			...readTimings(root),
			...entries.map((entry) => ({ ...entry, at })),
		].slice(-keep);
		mkdirSync(join(tmpdir(), "cagr"), { recursive: true });
		writeFileSync(file(root), JSON.stringify(all));
	} catch {}
}
