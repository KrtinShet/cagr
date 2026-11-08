/** A guard's verdict. `id` names the guard, so `cagr explain <id>` can say more. */
export type Finding = { id: string; reason: string };

export function render(finding: Finding) {
	return `${finding.reason} (cagr: ${finding.id})`;
}
