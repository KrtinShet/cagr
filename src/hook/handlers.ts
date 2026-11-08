import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { brief } from "../brief";
import type { Config } from "../config/schema";
import { gitContext } from "../git";
import { commandFinding, needsGitContext } from "../guards/command";
import { editFinding } from "../guards/edit";
import { render } from "../guards/finding";
import {
	agentApprovalFinding,
	gatePlan,
	gateTarget,
	githubReasons,
	isGateCommand,
	prBodyFinding,
} from "../guards/github";
import { insideRoot } from "../paths";
import { gateResult } from "../review/gate";
import { readRecord, recordPath } from "../review/store";
import {
	findInFiles,
	formatFinding,
	loadRules,
	RuleError,
} from "../rules/rules";
import { run, runShell } from "../run";
import { type CheckResult, needsCheck, stopDecision } from "../stop-decision";
import {
	clearTurnState,
	readTurnState,
	recordEdits,
	stateFile,
	writeTurnState,
} from "../turn-state";
import { focusOnChanged, stackFiles, tidy, withFiles } from "./stack-files";
import { recordTimings } from "./timings";
import type { Decision, HookInput } from "./types";

export const timeouts = { onEditMs: 10_000, onTurnEndMs: 60_000 };

export async function handle(
	input: HookInput,
	config: Config,
): Promise<Decision> {
	switch (input.event) {
		case "session.start":
			return { kind: "allow", context: brief(config) };
		case "command.before":
			return commandBefore(input, config);
		case "file.before_edit":
			return fileBeforeEdit(input, config);
		case "file.after_edit":
			return fileAfterEdit(input, config);
		case "turn.end":
			return turnEnd(input, config);
	}
}

async function commandBefore(
	input: HookInput,
	config: Config,
): Promise<Decision> {
	if (!input.command) return { kind: "allow" };
	let context = { branch: null as string | null, inMainCheckout: false };
	if (needsGitContext(input.command)) {
		const git = await gitContext(input.cwd);
		context = {
			branch: git.branch,
			inMainCheckout:
				config.git.worktree_only &&
				git.toplevel !== null &&
				git.toplevel === git.mainCheckout,
		};
	}
	const early =
		commandFinding(input.command, config, context) ??
		agentApprovalFinding(input.command, config);
	if (early) return { kind: "deny", reason: render(early) };
	if (!isGateCommand(input.command, config)) return { kind: "allow" };
	const plan = gatePlan(input.command, config, input.cwd);
	if ("finding" in plan) return { kind: "deny", reason: render(plan.finding) };
	const body = prBodyFinding(input.command, config, (path) =>
		readText(resolve(plan.dir, path)),
	);
	if (body) return { kind: "deny", reason: render(body) };
	return reviewGate(input.command, plan.dir, config, input.cwd);
}

function readText(path: string) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** Reads the branch's review record: two quick git calls (three when the command names a branch) and one file, to stay inside the command budget. */
async function reviewGate(
	command: string,
	cwd: string,
	config: Config,
	hookCwd: string,
): Promise<Decision> {
	const git = await gitContext(cwd);
	if (!git.commonDir) {
		// A cd out of a repo must not turn the gate off: `cd /tmp && gh pr create -R o/r --head b`.
		if (cwd === hookCwd || !(await gitContext(hookCwd)).commonDir)
			return { kind: "allow" };
		return {
			kind: "deny",
			reason: render({
				id: "review-gate",
				reason: githubReasons.cdOutsideRepo(),
			}),
		};
	}
	const target = gateTarget(command, config, git.branch, (path) =>
		readText(resolve(cwd, path)),
	);
	if ("reason" in target)
		return {
			kind: "deny",
			reason: render({ id: "review-gate", reason: target.reason }),
		};
	const named = target.branch;
	const branch = named ?? git.branch;
	if (!branch)
		return {
			kind: "deny",
			reason: render({
				id: "review-gate",
				reason:
					"HEAD is detached, so cagr cannot tell which branch this pull request is for. Check out the branch (`git switch <branch>`), or name it with --head <branch>.",
			}),
		};
	let head = git.head;
	if (named && named !== git.branch) {
		const result = await run(
			["git", "rev-parse", "--verify", "-q", `refs/heads/${named}^{commit}`],
			cwd,
		);
		head = result.ok ? result.stdout.trim() : null;
		if (!head)
			return {
				kind: "deny",
				reason: render({
					id: "review-gate",
					reason: `There is no local branch ${named}, so cagr cannot check its review. Check it out, run \`cagr review\` there, and open the pull request from it.`,
				}),
			};
	}
	const record = readRecord(recordPath(git.commonDir, branch));
	const result = gateResult(record, head, config);
	if (result.kind === "deny")
		return {
			kind: "deny",
			reason: render({ id: "review-gate", reason: result.reason }),
		};
	return result.notice
		? { kind: "allow", notice: result.notice }
		: { kind: "allow" };
}

async function fileBeforeEdit(
	input: HookInput,
	config: Config,
): Promise<Decision> {
	const mainCheckout = config.git.worktree_only
		? (await gitContext(input.cwd)).mainCheckout
		: null;
	for (const file of input.files) {
		const finding = editFinding(file, config, { mainCheckout });
		if (finding) return { kind: "deny", reason: render(finding) };
	}
	return { kind: "allow" };
}

async function fileAfterEdit(
	input: HookInput,
	config: Config,
): Promise<Decision> {
	const files = input.files.filter(
		(file) => insideRoot(config.root, file) !== null,
	);
	if (files.length === 0) return { kind: "allow" };
	await recordEdits(stateFile(input.sessionId), files);
	const problems = await editChecks(files, config);
	if (problems.length === 0) return { kind: "allow" };
	return {
		kind: "block",
		reason: tidy(
			`Your edit has problems. Fix them now.\n\n${problems.join("\n\n")}`,
		),
	};
}

/** The on_edit commands and code rules for `files`, as one section per failing check. */
export async function editChecks(
	files: string[],
	config: Config,
): Promise<string[]> {
	const existing = files.filter((file) => existsSync(file));
	const problems: string[] = [];
	const timings: { event: string; check: string; ms: number }[] = [];
	for (const stack of config.stack) {
		const paths = stackFiles(stack, existing, config);
		if (paths.length === 0) continue;
		for (const command of stack.on_edit) {
			const result = await runShell(withFiles(command, paths), config.root, {
				timeoutMs: timeouts.onEditMs,
			});
			timings.push({ event: "file.after_edit", check: command, ms: result.ms });
			if (!result.ok)
				problems.push(`## ${command}\n${tidy(result.output, 2000)}`);
		}
	}
	const rules = await ruleCheck(config, existing, "file.after_edit", timings);
	if (rules && !rules.ok) problems.push(`## Rules\n${rules.output}`);
	recordTimings(config.root, timings);
	return problems;
}

async function ruleCheck(
	config: Config,
	files: string[],
	event: string,
	timings: { event: string; check: string; ms: number }[],
): Promise<CheckResult | null> {
	const started = performance.now();
	try {
		const rules = loadRules(config);
		if (rules.length === 0) return null;
		const findings = await findInFiles(rules, files, config.root);
		timings.push({
			event,
			check: "rules",
			ms: Math.round(performance.now() - started),
		});
		return {
			name: "Rules",
			ok: findings.length === 0,
			output: tidy(findings.map(formatFinding).join("\n")),
		};
	} catch (error) {
		if (error instanceof RuleError)
			return { name: "Rules", ok: false, output: error.message };
		throw error;
	}
}

async function turnEnd(input: HookInput, config: Config): Promise<Decision> {
	const file = stateFile(input.sessionId);
	const state = await readTurnState(file);
	if (!needsCheck(state, config.root)) return { kind: "allow" };
	const changed = state.files.filter(
		(path) => insideRoot(config.root, path) !== null,
	);
	const existing = changed.filter((path) => existsSync(path));
	const timings: { event: string; check: string; ms: number }[] = [];
	// Two stacks that both run `bun run lint` run it once, on all their files.
	const commands = new Map<string, string[]>();
	for (const stack of config.stack) {
		if (stackFiles(stack, changed, config).length === 0) continue;
		const present = stackFiles(stack, existing, config);
		for (const command of stack.on_turn_end)
			commands.set(command, [
				...new Set([...(commands.get(command) ?? []), ...present]),
			]);
	}
	const checks = [...commands]
		.filter(
			([command, paths]) => !command.includes("{files}") || paths.length > 0,
		)
		.map(async ([command, paths]): Promise<CheckResult> => {
			const result = await runShell(withFiles(command, paths), config.root, {
				timeoutMs: timeouts.onTurnEndMs,
			});
			timings.push({ event: "turn.end", check: command, ms: result.ms });
			return {
				name: `\`${command}\``,
				ok: result.ok,
				output: tidy(focusOnChanged(result.output, paths)),
			};
		});
	const results = await Promise.all(checks);
	const rules = await ruleCheck(config, existing, "turn.end", timings);
	if (rules) results.push(rules);
	recordTimings(config.root, timings);
	const decision = stopDecision(state, results);
	if (decision.action === "block") {
		await writeTurnState(file, {
			...state,
			failedStops: state.failedStops + 1,
		});
		return { kind: "block", reason: decision.reason };
	}
	await clearTurnState(file);
	if (decision.action === "give-up")
		return {
			kind: "allow",
			notice: `cagr: ${decision.message} The agent was let go so it does not loop. Run the checks yourself before you merge.`,
		};
	return { kind: "allow" };
}
