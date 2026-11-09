import { basename } from "node:path";
import type { Config, LayoutRule } from "../config/schema";
import { matchesGlob } from "../paths";

export type LayoutFinding = {
	rule: string;
	path: string;
	/** What failed, for the agent: the name or the place. */
	detail: string;
	message: string;
	instead: string;
};

/** The file name without its extensions: `user-card` for `user-card.test.tsx`, `env` for `.env.local`. */
export function stem(path: string) {
	return basename(path).replace(/^\./, "").split(".")[0] ?? "";
}

function applies(rule: LayoutRule, path: string) {
	return (
		rule.files.some((glob) => matchesGlob(glob, path)) &&
		!rule.ignores.some((glob) => matchesGlob(glob, path))
	);
}

/** Layout findings for repo-relative paths. Pure and quick: no file reads, so it fits the before-edit budget. */
export function layoutFindings(
	rules: LayoutRule[],
	paths: string[],
): LayoutFinding[] {
	const findings: LayoutFinding[] = [];
	for (const path of paths)
		for (const rule of rules) {
			if (!applies(rule, path)) continue;
			const base = { rule: rule.id, path, message: rule.message };
			if (rule.name && !rule.name.test(stem(path)))
				findings.push({
					...base,
					detail: `the name "${stem(path)}" does not match ${rule.name}`,
					instead: rule.instead,
				});
			if (
				rule.allowed.length > 0 &&
				!rule.allowed.some((glob) => matchesGlob(glob, path))
			)
				findings.push({
					...base,
					detail: `it may only live at ${rule.allowed.join(" or ")}`,
					instead: rule.instead,
				});
		}
	return findings;
}

export function formatLayout(finding: LayoutFinding) {
	return `${finding.path} ${finding.rule}: ${finding.message} (${finding.detail}.) Instead: ${finding.instead}`;
}

export function explainLayout(rule: LayoutRule, config: Config) {
	return [
		`${rule.id} (layout rule from ${config.source})`,
		"",
		`Message: ${rule.message}`,
		`Instead: ${rule.instead}`,
		`Files: ${rule.files.join(", ")}${rule.ignores.length > 0 ? `, except ${rule.ignores.join(", ")}` : ""}`,
		...(rule.name
			? [`Name: the file name without extensions matches ${rule.name}`]
			: []),
		...(rule.allowed.length > 0
			? [`Allowed at: ${rule.allowed.join(", ")}`]
			: []),
	].join("\n");
}
