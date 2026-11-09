import { basename } from "node:path";
import { matchesGlob } from "../paths";
import type { ExampleResult } from "./rules";

/** A rule about file names and where files may live, from a rule file with a `layout:` block. */
export type LayoutRule = {
	id: string;
	files: string[];
	ignores: string[];
	name: RegExp | null;
	allowed: string[];
	message: string;
	instead: string;
	note: string | null;
	examples: { invalid: string[]; valid: string[] };
	source: string;
};

const ruleKeys = [
	"id",
	"layout",
	"message",
	"instead",
	"note",
	"examples",
	"url",
	"metadata",
];
const layoutKeys = ["files", "ignores", "name", "allowed"];

const isStringList = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((entry) => typeof entry === "string");

/** Reads one layout rule from a parsed rule file document, adding what is wrong to `problems`. */
export function toLayoutRule(
	raw: Record<string, unknown>,
	file: string,
	problems: string[],
): LayoutRule | null {
	const where = `${file}${typeof raw.id === "string" ? ` (${raw.id})` : ""}`;
	const before = problems.length;
	for (const key of Object.keys(raw))
		if (!ruleKeys.includes(key))
			problems.push(
				`${where}: "${key}" is not a layout rule key${key === "language" || key === "rule" ? ` (a rule with "layout" checks paths, not code: move "${key}" to a separate code rule)` : ""}. Allowed: ${ruleKeys.join(", ")}.`,
			);
	for (const key of ["id", "message", "instead"])
		if (typeof raw[key] !== "string" || (raw[key] as string).trim() === "")
			problems.push(
				`${where}: "${key}" is required${key === "instead" ? ": say what to do instead, so the agent can fix it" : ""}.`,
			);
	if (raw.note !== undefined && typeof raw.note !== "string")
		problems.push(`${where}: "note" must be text.`);
	const layout = raw.layout;
	let name: RegExp | null = null;
	let allowed: string[] = [];
	if (typeof layout !== "object" || layout === null || Array.isArray(layout)) {
		problems.push(
			`${where}: "layout" must be a mapping with files, and name or allowed.`,
		);
	} else {
		const block = layout as Record<string, unknown>;
		for (const key of Object.keys(block))
			if (!layoutKeys.includes(key))
				problems.push(
					`${where}: "layout.${key}" is not a layout key. Allowed: ${layoutKeys.join(", ")}.`,
				);
		if (!isStringList(block.files) || block.files.length === 0)
			problems.push(
				`${where}: "layout.files" is required: a list of globs, relative to the repo root, of the files this rule checks.`,
			);
		for (const key of ["ignores", "allowed"])
			if (block[key] !== undefined && !isStringList(block[key]))
				problems.push(`${where}: "layout.${key}" must be a list of globs.`);
		if (isStringList(block.allowed)) allowed = block.allowed;
		if (block.name !== undefined) {
			if (typeof block.name !== "string" || block.name === "")
				problems.push(
					`${where}: "layout.name" must be a regular expression, as text.`,
				);
			else
				try {
					name = new RegExp(block.name);
				} catch {
					problems.push(
						`${where}: "layout.name" ${JSON.stringify(block.name)} is not a valid regular expression.`,
					);
				}
		}
		if (block.name === undefined && allowed.length === 0)
			problems.push(
				`${where} checks nothing. Set layout.name (a regular expression for the file name) or layout.allowed (globs where the files may live).`,
			);
	}
	const examples = (raw.examples ?? {}) as Record<string, unknown>;
	for (const kind of ["invalid", "valid"])
		if (
			!isStringList(examples[kind]) ||
			(examples[kind] as string[]).length === 0
		)
			problems.push(
				`${where}: "examples.${kind}" needs at least one repo-relative path.`,
			);
	if (problems.length > before) return null;
	const block = layout as Record<string, unknown>;
	return {
		id: raw.id as string,
		files: block.files as string[],
		ignores: (block.ignores as string[] | undefined) ?? [],
		name,
		allowed,
		message: raw.message as string,
		instead: raw.instead as string,
		note: typeof raw.note === "string" ? raw.note : null,
		examples: {
			invalid: examples.invalid as string[],
			valid: examples.valid as string[],
		},
		source: file,
	};
}

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

/** Every invalid example path must break the rule and every valid one must not. */
export function testLayoutRules(rules: LayoutRule[]): ExampleResult[] {
	const results: ExampleResult[] = [];
	for (const rule of rules)
		for (const kind of ["invalid", "valid"] as const)
			for (const example of rule.examples[kind]) {
				const count = layoutFindings([rule], [example]).length;
				results.push({
					rule: rule.id,
					kind,
					example,
					matches: count,
					ok: kind === "invalid" ? count > 0 : count === 0,
				});
			}
	return results;
}

export function explainLayout(rule: LayoutRule) {
	return [
		`${rule.id} (layout rule from ${rule.source})`,
		"",
		`Message: ${rule.message}`,
		`Instead: ${rule.instead}`,
		...(rule.note ? [`Note: ${rule.note}`] : []),
		`Files: ${rule.files.join(", ")}${rule.ignores.length > 0 ? `, except ${rule.ignores.join(", ")}` : ""}`,
		...(rule.name
			? [`Name: the file name without extensions matches ${rule.name}`]
			: []),
		...(rule.allowed.length > 0
			? [`Allowed at: ${rule.allowed.join(", ")}`]
			: []),
		"",
		"Fires on:",
		...rule.examples.invalid.map((example) => `  ${example}`),
		"Allows:",
		...rule.examples.valid.map((example) => `  ${example}`),
	].join("\n");
}
