import type { Config } from "../config/schema";
import { describeTicket, Pool, poolSize } from "./pool";
import { gib, pressureReader, supportsAdmission } from "./pressure";

export async function admissionReport(config: Config["admission"]) {
	const line = (text: string) => ({ ok: true, text });
	if (!supportsAdmission)
		return [line("Memory admission is available on macOS and Linux.")];
	try {
		const pool = new Pool();
		const snapshot = await pool.transaction(performance.now() + 500, () => ({
			costs: pool.costs(),
			entries: pool.list(),
		}));
		if (!snapshot)
			return [
				line("The admission queue is busy. Rerun cagr doctor to inspect it."),
			];
		const { costs, entries } = snapshot;
		const held = entries.filter((entry) => entry.slots.length);
		const queue = entries.filter((entry) => !entry.slots.length);
		const pressure = pressureReader(config)();
		return [
			line(
				`Pool: ${poolSize(config, costs)} token(s), ${held.reduce((sum, ticket) => sum + ticket.slots.length, 0)} held. ${config.enabled ? "Enabled." : "Disabled for this repo."}`,
			),
			...held.map((ticket) =>
				line(`Held ${ticket.slots.length}: ${describeTicket(ticket)}`),
			),
			...(queue.length
				? queue.map((ticket, index) =>
						line(
							`Queue #${index + 1} (${ticket.priority}): ${describeTicket(ticket)}`,
						),
					)
				: [line("Queue empty.")]),
			line(
				`Pressure: ${pressure.elevated ? "elevated" : "normal"} (${pressure.description})`,
			),
			...(costs
				? [
						line(
							`Measured machine: ${(costs.totalBytes / gib).toFixed(1)} GiB RAM, ${(costs.dockerBytes / gib).toFixed(1)} GiB Docker Desktop, ${costs.poolTokens} token(s) before repo cap.`,
						),
						...Object.entries(costs.peaks).map(([key, peak]) => {
							const [repo, pattern] = JSON.parse(key) as [string, string];
							return line(
								`${repo}: ${pattern}, ${(peak / gib).toFixed(2)} GiB peak, ${Math.ceil(peak / gib)} token(s)`,
							);
						}),
					]
				: [line("No measured costs. Run cagr measure -- <cmd...>.")]),
		];
	} catch (error) {
		return [line(`Memory admission unavailable. ${error}`)];
	}
}
