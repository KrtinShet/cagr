import type { Config } from "./config/schema";
import { findingCommand } from "./findings/command";
import { ecosystemOf } from "./guards/package-manager";
import { loadRules, type Rule, RuleError } from "./rules/rules";

/** A short brief for the agent at session start, built from the config. */
export function brief(
	config: Config,
	rules: Rule[] = safeRules(config),
): string {
	const lines = [
		"cagr checks this repo. When it blocks something, its message says what to do instead.",
	];
	if (config.suppressions.enabled)
		lines.push(
			"- Do not add suppression comments or edit lint configs. Fix the cause, or tell the user which rule gets in the way and why.",
		);
	const managers = new Map<string, string[]>();
	for (const stack of config.stack) {
		if (!stack.package_manager) continue;
		const ecosystem =
			ecosystemOf(stack.package_manager)?.name ?? stack.language;
		const list = managers.get(ecosystem) ?? [];
		if (!list.includes(stack.package_manager)) list.push(stack.package_manager);
		managers.set(ecosystem, list);
	}
	if (managers.size > 0)
		lines.push(
			`- Package managers: ${[...managers].map(([ecosystem, list]) => `${list.join(" or ")} for ${ecosystem}`).join(", ")}.`,
		);
	const git: string[] = [];
	if (config.git.protected_branch)
		git.push(
			`never push to ${config.git.protected_branch}, push a branch and open a pull request`,
		);
	if (config.git.branch_name)
		git.push(`branches look like ${config.git.branch_name.example}`);
	if (config.git.commit_message)
		git.push(
			`commit subjects look like "${config.git.commit_message.example}"`,
		);
	if (config.git.block_force_push) git.push("no force pushes");
	if (config.git.block_hook_skips) git.push("no --no-verify");
	if (config.git.worktree_only)
		git.push(
			`work in a worktree under ${config.git.worktree_dir}/, not in the main checkout`,
		);
	if (git.length > 0) lines.push(`- Git: ${git.join("; ")}.`);
	if (config.files.protected.length > 0)
		lines.push(
			`- Do not edit: ${config.files.protected.map((entry) => entry.glob).join(", ")}.`,
		);
	if (config.commands.blocked.length > 0)
		lines.push(
			`- Do not run: ${config.commands.blocked.map((entry) => `\`${entry.match}\``).join(", ")}.`,
		);
	for (const stack of config.stack) {
		const parts: string[] = [];
		if (stack.on_edit.length > 0)
			parts.push(
				`after each edit \`${stack.on_edit.join("`, `")}\` run on the changed files`,
			);
		if (stack.on_turn_end.length > 0)
			parts.push(
				`before you finish \`${stack.on_turn_end.join("`, `")}\` must pass`,
			);
		if (parts.length > 0)
			lines.push(
				`- ${stack.language} (${stack.paths.join(", ")}): ${parts.join("; ")}.`,
			);
	}
	if (config.findings.mode === "new") {
		const compared = [
			...new Set(config.stack.flatMap((stack) => stack.on_edit)),
		].filter((command) => findingCommand(command));
		lines.push(
			`- New findings mode: ${compared.length ? compared.map((command) => `\`${command}\``).join(", ") : "no configured commands"} compared against first-touch source when a baseline and complete JSON are available. All other commands, turn-end checks, CI and code rules still must fully pass. Biome stays strict because its stdin mode does not emit JSON.`,
		);
	}
	if (rules.length > 0)
		lines.push(
			`- ${rules.length} code rule${rules.length === 1 ? "" : "s"} (${rules.map((rule) => rule.id).join(", ")}). \`cagr explain <id>\` shows one.`,
		);
	if (config.review.enabled && config.review.gate.length > 0)
		lines.push(
			`- Before ${config.review.gate.map((match) => `\`${match}\``).join(" or ")}, commit and run \`cagr review\` (give it a 15 minute timeout). Fix or answer every Important finding.${config.review.pr_sections.length > 0 ? ` The pull request body needs these headings: ${config.review.pr_sections.join(", ")}.` : ""}`,
		);
	if (!config.review.agents_may_merge)
		lines.push("- Do not merge or approve pull requests. A person does that.");
	for (const rule of config.changes.rules)
		lines.push(`- Change rule ${rule.id}: ${rule.reason}`);
	lines.push(...config.brief.map((line) => `- ${line}`));
	return lines.join("\n");
}

function safeRules(config: Config) {
	try {
		return loadRules(config);
	} catch (error) {
		if (error instanceof RuleError) return [];
		throw error;
	}
}
