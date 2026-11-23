import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type TurnState = { files: string[]; failedStops: number };

const empty: TurnState = { files: [], failedStops: 0 };

export function stateFile(
	sessionId: string,
	directory = join(tmpdir(), "cagr", "sessions"),
) {
	return join(directory, `${sessionId.replace(/[^\w-]/g, "_")}.json`);
}

export async function readTurnState(file: string): Promise<TurnState> {
	try {
		return { ...empty, ...JSON.parse(await readFile(file, "utf8")) };
	} catch {
		return empty;
	}
}

export async function writeTurnState(file: string, state: TurnState) {
	await mkdir(join(file, ".."), { recursive: true });
	await writeFile(file, JSON.stringify(state));
}

export async function recordEdits(file: string, files: string[]) {
	const state = await readTurnState(file);
	await writeTurnState(file, {
		...state,
		files: [...new Set([...state.files, ...files])],
	});
}

export const protectedStateDir = (file: string) => `${file}.protected`;
export const protectedNoticesDir = (file: string) =>
	`${file}.protected-notices`;

const turnStartPath = (file: string) =>
	join(protectedStateDir(file), ".started");

export async function startTurn(file: string) {
	const path = turnStartPath(file);
	if (!existsSync(path)) await mkdir(path, { recursive: true, mode: 0o700 });
}

export async function turnStartedAt(file: string) {
	// Creating the marker is atomic across parallel hooks. Its time uses the same clock as file ctime.
	return (await stat(turnStartPath(file)).catch(() => null))?.mtimeMs;
}

export async function clearTurnState(file: string) {
	await Promise.all([
		rm(file, { force: true }),
		rm(protectedStateDir(file), { recursive: true, force: true }),
	]);
}
