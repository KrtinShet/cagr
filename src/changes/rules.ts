import { basename, dirname, extname } from "node:path";
import { guardIds } from "../guards/catalog";
import { matchesGlob } from "../paths";

export type Change = {
	path: string;
	status: "A" | "M" | "D" | "T";
	regular?: boolean;
	before?: string;
	after?: string;
};
export type ChangeRule = {
	id: string;
	kind: "requires" | "add_only" | "sibling";
	paths: string[];
	ignores: string[];
	reason: string;
	note?: string;
	require?: string[];
	target?: string;
	source: string;
	examples: {
		valid: { changes: Change[] }[];
		invalid: { changes: Change[] }[];
	};
};
export type ChangeFinding = {
	rule: string;
	path: string;
	message: string;
	reason: string;
};
export function targetPath(template: string, path: string): string {
	const ext = extname(path);
	return template
		.replace(
			/\{(dir|name|ext)\}/g,
			(_, key: string) =>
				({
					dir: dirname(path) === "." ? "" : dirname(path),
					name: basename(path, ext),
					ext: ext.slice(1),
				})[key] ?? "",
		)
		.replace(/^\//, "");
}
export function evaluate(
	rules: ChangeRule[],
	changes: Change[],
): ChangeFinding[] {
	let operations = 0;
	const match = (pattern: string, path: string) => {
		if (++operations > 2_000_000)
			throw Error(
				"Change evaluation exceeds 2000000 comparisons. Narrow the rules or change size.",
			);
		return matchesGlob(pattern, path);
	};
	const selected = (patterns: string[], path: string) =>
		patterns.some((pattern) => match(pattern, path));
	const findings: ChangeFinding[] = [];
	const companions = changes.filter(
		(change) =>
			(change.status === "A" || change.status === "M") &&
			change.regular !== false,
	);
	for (const rule of rules) {
		const triggers = changes.filter(
			(change) =>
				selected(rule.paths, change.path) &&
				!selected(rule.ignores, change.path),
		);
		const add = (path: string, message: string) =>
			findings.push({ rule: rule.id, path, message, reason: rule.reason });
		if (rule.kind === "requires" && triggers.length) {
			for (const required of rule.require ?? [])
				if (!companions.some((change) => match(required, change.path)))
					add(
						triggers[0]?.path ?? "",
						`${triggers[0]?.path ?? ""} changed; ${required} must be added or modified as a regular file.`,
					);
		} else if (rule.kind === "add_only") {
			for (const change of triggers)
				if (change.status !== "A")
					add(
						change.path,
						`${change.path} existed at the baseline and was changed (${change.status}).`,
					);
		} else if (rule.kind === "sibling") {
			for (const change of triggers.filter((change) => change.status === "A")) {
				const target = targetPath(rule.target ?? "", change.path);
				if (!companions.some((companion) => companion.path === target))
					add(
						change.path,
						`Added ${change.path}; ${target} must be added or modified as a regular file.`,
					);
			}
		}
	}
	return findings;
}
export function formatChange(finding: ChangeFinding): string {
	return `Change rule ${finding.rule} failed.\n${finding.message}\nInstead: ${finding.reason}`;
}
export function testChanges(rules: ChangeRule[]) {
	return rules.flatMap((rule) =>
		(["valid", "invalid"] as const).flatMap((kind) =>
			rule.examples[kind].map((example) => {
				const matches = evaluate([rule], example.changes).length;
				return {
					rule: rule.id,
					kind,
					example: JSON.stringify(example),
					path: undefined,
					skipped: undefined,
					matches,
					ok: kind === "valid" ? matches === 0 : matches > 0,
				};
			}),
		),
	);
}
export function resolveChangeRules(
	rules: ChangeRule[],
	sources: string[],
): ChangeRule[] {
	if (rules.length > 1000)
		throw Error("Too many change rules. Keep at most 1000 rules.");
	const seen = new Map<string, string>();
	return rules.map((raw) => {
		const rule = {
			...raw,
			ignores: raw.ignores ?? [],
			source: sources.join(", "),
		};
		const fail = (why: string): never => {
			throw Error(`${rule.source}: change rule ${rule.id}: ${why}`);
		};
		if (!/^[a-zA-Z0-9][\w-]*$/.test(rule.id) || guardIds.includes(rule.id))
			fail("Choose a unique rule id that is not a built-in guard.");
		if (seen.has(rule.id))
			fail(`Id also used in ${seen.get(rule.id)}. Give each rule its own id.`);
		seen.set(rule.id, rule.source);
		if (
			rule.reason.length > 2000 ||
			[...rule.paths, ...rule.ignores, ...(rule.require ?? [])].some(
				(path) => path.length > 1000 || !path.trim() || path.startsWith("!"),
			)
		)
			fail(
				"Use nonblank positive globs under 1001 characters and a reason under 2001 characters.",
			);
		if (
			!rule.reason.trim() ||
			!rule.paths.length ||
			rule.paths.some((path) => !path.trim() || path.startsWith("!"))
		)
			fail("Supply nonblank paths and a reason saying what to do instead.");
		if (
			rule.kind === "requires" &&
			(!rule.require?.length || rule.require.some((path) => !path.trim()))
		)
			fail("Supply at least one required companion glob.");
		if (rule.kind === "sibling") {
			const target = (rule.target ?? "").replace(/\{(dir|name|ext)\}/g, "x");
			if (
				!target.trim() ||
				/[{}*?[\]\\]/.test(target) ||
				target.startsWith("/") ||
				/^[A-Za-z]:/.test(target) ||
				target.split("/").includes("..")
			)
				fail(
					"Use a relative exact target with only {dir}, {name} and {ext} placeholders and no .. components.",
				);
		}
		for (const kind of ["valid", "invalid"] as const) {
			if (!rule.examples[kind].length)
				fail(`Add at least one ${kind} example.`);
			for (const example of rule.examples[kind]) {
				const paths = new Set<string>();
				for (const change of example.changes) {
					if (
						!change.path.trim() ||
						change.path.startsWith("/") ||
						change.path.split("/").includes("..") ||
						paths.has(change.path) ||
						(change.status === "A" && change.before !== undefined) ||
						(change.status === "D" && change.after !== undefined)
					)
						fail(
							"Use unique relative fixture paths and content only on sides that exist.",
						);
					paths.add(change.path);
				}
			}
		}
		return rule;
	});
}
