import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

export async function clearTurnState(file: string) {
	await rm(file, { force: true });
}
