import { resolve } from "node:path";
import { checkAll } from "./check-all";
import { annotations, ci, ciReport, publish } from "./ci";
import { jsonSchema } from "./config/json-schema";
import { ConfigError, loadConfig } from "./config/load";
import { type AgentName, agentNames, type Config } from "./config/schema";
import { doctor } from "./doctor";
import {
	commitMsg,
	type GitHookName,
	gitHookNames,
	prePush,
} from "./git-hooks";
import { guards } from "./guards/catalog";
import { editFinding } from "./guards/edit";
import { render } from "./guards/finding";
import { editChecks } from "./hook/handlers";
import { runHook } from "./hook/run-hook";
import { type AgentEvent, agentEvents } from "./hook/types";
import { init } from "./init";
import { ReviewerError } from "./review/agent";
import { reviewCommand, riskCommand } from "./review/cli";
import { ghCli } from "./review/github";
import { AnswerError } from "./review/report";
import { ReviewInputError } from "./review/review";
import { postStatusAfterPush } from "./review/status";
import { explainLayout, testLayoutRules } from "./rules/layout";
import {
	type CodeExample,
	loadRuleSet,
	RuleError,
	testRules,
} from "./rules/rules";
import {
	GitSetupError,
	installGitHooks,
	keptNotes,
	SyncError,
	sync,
} from "./sync";
import { version } from "./version";

const help = `cagr ${version}: one config for every coding agent's guardrails.

Usage: cagr <command>

  init [--dry-run] [--force]   Detect the repo, write cagr.toml, the agent hooks and the git hooks.
  sync [--check]               Rewrite the generated agent and git hook files. --check fails on drift.
  install-git-hooks            Write the git hooks and set core.hooksPath.
  doctor [--github]            Check the wiring, the tools each check needs, and hook timings.
                               --github also checks branch protection through gh.
  review [...]                 Review this branch with a reviewer agent. \`cagr review help\` for more.
  risk [--base <b>] [files]    The risk tier of this branch's change, the approvals it needs, the owners.
  ci [--base <branch>]         In CI: the same checks the hooks ran, on the branch's changed files.
  check <files...> | --all     Run the edit checks and code rules on files, or the
                               code and layout rules on every file.
  explain <id>                 Explain a guard, a code rule or a layout rule.
  rules test                   Check every rule's examples: invalid ones must fire, valid ones must not.
  schema                       Print the JSON schema for cagr.toml.
  hook <event> --agent <name>  Called by agent hooks: reads the agent's JSON on stdin.
  git <hook> [args]            Called by git hooks: ${gitHookNames.join(", ")}.
  post-status <sha> --branch <b> [--checks] [--wait <s>]
                               Called by the pre-push hook when [review] status is on: sets the
                               cagr/review and cagr/checks commit statuses once GitHub has <sha>.

Events: ${agentEvents.join(", ")}. Agents: ${agentNames.join(", ")}.`;

class UsageError extends Error {}

function requireConfig(): Config {
	const config = loadConfig(process.cwd());
	if (!config)
		throw new UsageError(
			"No cagr.toml (or [tool.cagr] in pyproject.toml) here or above. Run `cagr init`.",
		);
	return config;
}

function flag(args: string[], name: string) {
	const index = args.indexOf(name);
	if (index === -1) return null;
	const value = args[index + 1];
	args.splice(index, 2);
	return value ?? "";
}

/** The options each command takes. `hook`, `git` and `review` check their own. */
const options: Record<string, string[]> = {
	init: ["--dry-run", "--force"],
	sync: ["--check"],
	"install-git-hooks": [],
	doctor: ["--github"],
	risk: ["--base"],
	ci: ["--base"],
	check: ["--all"],
	explain: [],
	rules: [],
	schema: [],
	"post-status": ["--branch", "--wait", "--checks"],
};

/** Help for a command, or a UsageError for an option it does not take. */
export function checkOptions(command: string, args: string[]): string | null {
	const allowed = options[command];
	if (!allowed) return null;
	if (args.includes("--help") || args.includes("-h")) return help;
	const unknown = args.find(
		(arg) => arg.startsWith("-") && !allowed.includes(arg),
	);
	if (unknown)
		throw new UsageError(
			`\`cagr ${command}\` has no option ${unknown}. ${allowed.length > 0 ? `It takes ${allowed.join(", ")}.` : "It takes none."} \`cagr help\` lists every command.`,
		);
	return null;
}

async function main(argv: string[]): Promise<number> {
	const [command, ...args] = argv;
	const commandHelp = command ? checkOptions(command, args) : null;
	if (commandHelp) {
		console.log(commandHelp);
		return 0;
	}
	switch (command) {
		case undefined:
		case "help":
		case "--help":
		case "-h":
			console.log(help);
			return 0;
		case "--version":
		case "version":
			console.log(version);
			return 0;
		case "hook": {
			const agent = (flag(args, "--agent") ?? "claude") as AgentName;
			const event = args[0] as AgentEvent;
			if (!agentEvents.includes(event))
				throw new UsageError(
					`Unknown event "${event}". Events: ${agentEvents.join(", ")}.`,
				);
			if (!agentNames.includes(agent))
				throw new UsageError(
					`Unknown agent "${agent}". Agents: ${agentNames.join(", ")}.`,
				);
			const output = await runHook(
				agent,
				event,
				await Bun.stdin.text(),
				process.cwd(),
			);
			if (output) process.stdout.write(`${output}\n`);
			return 0;
		}
		case "git": {
			const hook = args[0] as GitHookName;
			if (!gitHookNames.includes(hook))
				throw new UsageError(
					`Unknown git hook "${hook}". Hooks: ${gitHookNames.join(", ")}.`,
				);
			let config: Config | null;
			try {
				config = loadConfig(process.cwd());
			} catch (error) {
				console.error(
					`cagr: the ${hook} hook did not run. ${(error as Error).message}`,
				);
				return 0;
			}
			if (!config) return 0;
			const result =
				hook === "commit-msg"
					? commitMsg(args[1] ?? ".git/COMMIT_EDITMSG", config)
					: await prePush(await Bun.stdin.text(), config, process.cwd());
			for (const message of result.messages) console.error(`cagr: ${message}`);
			if (!result.ok)
				console.error(
					`A human can skip this once with ${config.git.skip_env}=1.`,
				);
			return result.ok ? 0 : 1;
		}
		case "init": {
			const dryRun = args.includes("--dry-run");
			const result = await init(process.cwd(), {
				dryRun,
				force: args.includes("--force"),
			});
			const found = result.detection.stacks.map(
				(stack) =>
					`  ${stack.language} in ${stack.dir || "."}${stack.package_manager ? ` with ${stack.package_manager}` : ""}${stack.tools.length > 0 ? `, tools: ${stack.tools.join(", ")}` : ""}`,
			);
			console.log(
				`Found:\n${found.length > 0 ? found.join("\n") : "  no JavaScript or Python projects"}\n  agents: ${result.detection.agents.join(", ")}\n  protected branch: ${result.detection.protectedBranch}\n`,
			);
			console.log(
				`${dryRun ? "Would write" : "Wrote"} cagr.toml:\n\n${result.config}`,
			);
			if (!dryRun)
				console.log(
					`Wrote:\n${result.written.map((file) => `  ${file}`).join("\n")}`,
				);
			for (const note of result.notes) console.log(note);
			return 0;
		}
		case "sync": {
			const check = args.includes("--check");
			const result = sync(requireConfig(), { check });
			for (const note of keptNotes(result.kept, result.removed))
				console.log(note);
			if (check) {
				if (result.drifted.length === 0) {
					console.log("Generated files are up to date.");
					return 0;
				}
				console.error(
					`Out of date: ${result.drifted.join(", ")}. Run \`cagr sync\`.`,
				);
				return 1;
			}
			console.log(
				result.written.length > 0
					? `Wrote ${result.written.join(", ")}.`
					: "Already up to date.",
			);
			return 0;
		}
		case "install-git-hooks": {
			const config = requireConfig();
			const result = await installGitHooks(config);
			console.log(
				`Git hooks in ${config.git.hooks_path} (${result.written.length > 0 ? "written" : "already up to date"}); core.hooksPath set.`,
			);
			return 0;
		}
		case "doctor": {
			const result = await doctor(requireConfig(), {
				github: args.includes("--github") ? ghCli : undefined,
			});
			console.log(result.report);
			return result.ok ? 0 : 1;
		}
		case "check": {
			if (args.includes("--all")) {
				if (args.length > 1)
					throw new UsageError(
						"cagr check --all checks every file. Drop the file names, or drop --all.",
					);
				const result = await checkAll(requireConfig());
				console.log(result.report);
				return result.ok ? 0 : 1;
			}
			if (args.length === 0)
				throw new UsageError(
					"Name the files to check: cagr check <files...>, or check every file: cagr check --all",
				);
			const config = requireConfig();
			const files = args.map((file) => resolve(file));
			const problems = files
				.map((file) => editFinding(file, config, { mainCheckout: null }))
				.filter((finding) => finding !== null)
				.map((finding) => `## ${finding.id}\n${render(finding)}`);
			problems.push(...(await editChecks(files, config)));
			if (problems.length === 0) {
				console.log(
					`No problems in ${files.length} file${files.length === 1 ? "" : "s"}.`,
				);
				return 0;
			}
			console.log(problems.join("\n\n"));
			return 1;
		}
		case "explain": {
			const id = args[0];
			const guard = guards.find((entry) => entry.id === id);
			if (guard) {
				console.log(
					`${guard.id} (built-in guard, runs on ${guard.event})\n\nCatches: ${guard.catches}\nFix: ${guard.fix}\nConfig: ${guard.config}`,
				);
				return 0;
			}
			const config = loadConfig(process.cwd());
			const { code: rules, layout } = config
				? loadRuleSet(config)
				: { code: [], layout: [] };
			const layoutRule = layout.find((entry) => entry.id === id);
			if (layoutRule) {
				console.log(explainLayout(layoutRule));
				return 0;
			}
			const rule = rules.find((entry) => entry.id === id);
			if (!rule) {
				console.error(
					`No guard or rule "${id ?? ""}". Known: ${[...guards.map((g) => g.id), ...rules.map((r) => r.id), ...layout.map((l) => l.id)].join(", ")}.`,
				);
				return 1;
			}
			console.log(
				[
					`${rule.id} (${rule.languages.join(", ")} rule from ${rule.source})`,
					"",
					`Message: ${rule.message}`,
					`Instead: ${rule.instead}`,
					...(rule.note ? [`Note: ${rule.note}`] : []),
					...(rule.imports
						? [
								`Imports: may not import ${rule.imports.forbid.join(", ")}${rule.imports.allow.length > 0 ? `, except ${rule.imports.allow.join(", ")}` : ""}`,
							]
						: []),
					"",
					"Fires on:",
					...rule.examples.invalid.map(showExample),
					"Allows:",
					...rule.examples.valid.map(showExample),
				].join("\n"),
			);
			return 0;
		}
		case "rules": {
			if (args[0] !== "test") throw new UsageError("Usage: cagr rules test");
			const config = requireConfig();
			const { code, layout } = loadRuleSet(config);
			const results = [
				...(await testRules(code, config.root)),
				...testLayoutRules(layout),
			];
			for (const result of results.filter((entry) => !entry.ok))
				console.log(
					`FAIL ${result.rule}: ${result.kind} example${result.path ? ` at ${result.path}` : ""} ${result.kind === "invalid" ? `did not fire${result.skipped ? ` (${result.skipped})` : ""}` : result.skipped ? `was not checked (${result.skipped})` : `fired ${result.matches} time${result.matches === 1 ? "" : "s"}`}:\n  ${result.example.trim().replace(/\n/g, "\n  ")}`,
				);
			const failed = results.filter((entry) => !entry.ok).length;
			console.log(
				`${code.length + layout.length} rules, ${results.length} examples, ${failed} failed.`,
			);
			return failed === 0 ? 0 : 1;
		}
		case "review":
			return reviewCommand(requireConfig(), args, process.cwd());
		case "risk":
			return riskCommand(requireConfig(), args, process.cwd());
		case "ci": {
			const base = flag(args, "--base") ?? undefined;
			const result = await ci(requireConfig(), { cwd: process.cwd(), base });
			console.log(ciReport(result));
			if (process.env.GITHUB_ACTIONS) {
				for (const line of annotations(result)) console.log(line);
				publish(result);
			}
			return result.ok ? 0 : 1;
		}
		case "schema":
			console.log(JSON.stringify(jsonSchema(), null, "\t"));
			return 0;
		case "post-status": {
			const branch = flag(args, "--branch");
			const wait = Number(flag(args, "--wait") ?? "0");
			const checks = args.includes("--checks");
			const sha = args.find((arg) => !arg.startsWith("-"));
			if (!sha || !branch || !Number.isFinite(wait))
				throw new UsageError(
					"Usage: cagr post-status <sha> --branch <branch> [--checks] [--wait <seconds>]",
				);
			const config = requireConfig();
			const lines = await postStatusAfterPush(
				config,
				process.cwd(),
				{
					sha,
					branch,
					checks: checks ? config.git.pre_push : null,
					waitSeconds: wait,
				},
				ghCli,
			);
			for (const line of lines)
				console.log(`${new Date().toISOString()} ${line}`);
			return 0;
		}
		default:
			throw new UsageError(`Unknown command "${command}".\n\n${help}`);
	}
}

const showExample = (example: CodeExample) =>
	`  ${example.path ? `${example.path}: ` : ""}${example.code.trim().replace(/\n/g, "\n  ")}`;

const expected = (error: unknown) =>
	error instanceof UsageError ||
	error instanceof GitSetupError ||
	error instanceof SyncError ||
	error instanceof ConfigError ||
	error instanceof RuleError ||
	error instanceof ReviewInputError ||
	error instanceof ReviewerError ||
	error instanceof AnswerError;

export function runCli(argv: string[]) {
	main(argv).then(
		(code) => process.exit(code),
		(error) => {
			console.error(
				expected(error)
					? (error as Error).message
					: ((error as Error).stack ?? String(error)),
			);
			process.exit(2);
		},
	);
}

if (import.meta.main) runCli(process.argv.slice(2));
