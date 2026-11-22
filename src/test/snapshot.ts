import { afterAll, beforeAll } from "bun:test";
import { snapshotBudget } from "../guards/protected-turn";

/** Raises the protected-file snapshot budget for a test file. The real one is tight, and a loaded machine can miss it and change what a hook reports. */
export function roomySnapshots() {
	const budget = { ...snapshotBudget };
	beforeAll(() => {
		snapshotBudget.commandMs = 10_000;
		snapshotBudget.toolMs = 10_000;
	});
	afterAll(() => {
		Object.assign(snapshotBudget, budget);
	});
}
