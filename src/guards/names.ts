import type { Config } from "../config/schema";
import type { Finding } from "./finding";

export function branchFinding(name: string, config: Config): Finding | null {
	const rule = config.git.branch_name;
	if (!rule || name === "HEAD" || name === config.git.protected_branch)
		return null;
	if (rule.pattern.test(name)) return null;
	return {
		id: "branch-name",
		reason: [
			`Branch "${name}" does not match ${rule.label}, for example ${rule.example}.`,
			`Rename it with \`git branch -m ${name} <new-name>\`.`,
			rule.hint,
		]
			.filter(Boolean)
			.join(" "),
	};
}

const exempt = /^(Merge |Revert |fixup! |squash! )/;

export function commitMessageFinding(
	text: string,
	config: Config,
): Finding | null {
	const rule = config.git.commit_message;
	if (!rule) return null;
	const subject = text.split("\n").find((line) => !line.startsWith("#")) ?? "";
	if (exempt.test(subject)) return null;
	if (!rule.pattern.test(subject))
		return {
			id: "commit-message",
			reason: [
				`Commit subject "${subject}" does not match ${rule.label}.`,
				`Example: ${rule.example}.`,
				rule.hint,
			]
				.filter(Boolean)
				.join(" "),
		};
	if (rule.maxLength && subject.length > rule.maxLength)
		return {
			id: "commit-message",
			reason: `Commit subject is ${subject.length} characters. Keep it to ${rule.maxLength} or fewer; put detail in the body.`,
		};
	return null;
}
