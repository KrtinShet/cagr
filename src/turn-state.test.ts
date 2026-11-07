import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clearTurnState,
	readTurnState,
	recordEdits,
	stateFile,
	writeTurnState,
} from "./turn-state";

test("collects edits across tool calls until cleared", async () => {
	const file = stateFile(
		"session/1",
		await mkdtemp(join(tmpdir(), "turn-state-")),
	);
	expect(await readTurnState(file)).toEqual({ files: [], failedStops: 0 });

	await recordEdits(file, ["/repo/a.ts"]);
	await recordEdits(file, ["/repo/a.ts", "/repo/b.ts"]);
	expect(await readTurnState(file)).toEqual({
		files: ["/repo/a.ts", "/repo/b.ts"],
		failedStops: 0,
	});

	await writeTurnState(file, { files: ["/repo/a.ts"], failedStops: 2 });
	await recordEdits(file, ["/repo/c.ts"]);
	expect((await readTurnState(file)).failedStops).toBe(2);

	await clearTurnState(file);
	expect(await readTurnState(file)).toEqual({ files: [], failedStops: 0 });
});

test("keeps session ids from escaping the directory", () => {
	expect(stateFile("../../etc", "/state")).toBe("/state/______etc.json");
});
