import type { Config, RiskTier } from "./config/schema";
import { matchesGlob } from "./paths";

const rank: Record<RiskTier, number> = { low: 0, medium: 1, high: 2 };
export const approvalsFor: Record<RiskTier, number> = {
	low: 0,
	medium: 1,
	high: 2,
};

export type FileRisk = {
	path: string;
	tier: RiskTier;
	reason: string | null;
	owners: string[];
};
export type RiskResult = {
	tier: RiskTier;
	approvals: number;
	files: FileRisk[];
	owners: string[];
	/** The reasons behind the change's tier, for the review prompt. */
	reasons: string[];
};

export const higher = (a: RiskTier, b: RiskTier) => (rank[b] > rank[a] ? b : a);

/** A file takes the highest tier of the entries it matches, or the default when none match. */
export function fileRisk(path: string, config: Config): FileRisk {
	const matches = config.risk.paths.filter((entry) =>
		matchesGlob(entry.glob, path),
	);
	if (matches.length === 0)
		return { path, tier: config.risk.default, reason: null, owners: [] };
	const top = matches.reduce((best, entry) =>
		rank[entry.tier] > rank[best.tier] ? entry : best,
	);
	return {
		path,
		tier: top.tier,
		reason: top.reason,
		owners: [...new Set(matches.flatMap((entry) => entry.owners))],
	};
}

/** The change takes the highest tier of its files. */
export function classify(paths: string[], config: Config): RiskResult {
	const files = paths.map((path) => fileRisk(path, config));
	const tier = files.reduce<RiskTier>(
		(top, file) => higher(top, file.tier),
		"low",
	);
	const top = files.filter((file) => file.tier === tier);
	const reasons = [
		...new Set(
			top.map(
				(file) => file.reason ?? `${file.path} is ${file.tier} by default`,
			),
		),
	].slice(0, 5);
	return {
		tier: files.length === 0 ? "low" : tier,
		approvals: approvalsFor[files.length === 0 ? "low" : tier],
		files,
		owners: [...new Set(files.flatMap((file) => file.owners))],
		reasons,
	};
}

export function riskReport(result: RiskResult) {
	const lines = [
		`Risk: ${result.tier}. Needs ${result.approvals === 0 ? "no human approval once checks and review pass" : `${result.approvals} human approval${result.approvals === 1 ? "" : "s"}`}.`,
	];
	if (result.reasons.length > 0)
		lines.push(`Why: ${result.reasons.join("; ")}.`);
	if (result.owners.length > 0)
		lines.push(`Owners: ${result.owners.join(", ")}.`);
	const byTier = (tier: RiskTier) =>
		result.files.filter((file) => file.tier === tier);
	for (const tier of ["high", "medium", "low"] as const) {
		const files = byTier(tier);
		if (files.length > 0)
			lines.push(
				`${tier} (${files.length}): ${files
					.slice(0, 10)
					.map((file) => file.path)
					.join(", ")}${files.length > 10 ? ", ..." : ""}`,
			);
	}
	return lines.join("\n");
}
