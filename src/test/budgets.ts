import { afterAll, beforeAll } from "bun:test";

export const repoTestTimeout = 30_000;

/** Keep the host scheduler from deciding policy assertions in integration tests. */
export function roomyBudgets(...budgets: Record<string, number>[]) {
	let original: Record<string, number>[];
	beforeAll(() => {
		original = budgets.map((budget) => ({ ...budget }));
		for (const budget of budgets)
			for (const key of Object.keys(budget))
				budget[key] = Math.max(budget[key] ?? 0, 30_000);
	});
	afterAll(() => {
		budgets.forEach((budget, index) => {
			Object.assign(budget, original[index]);
		});
	});
}
