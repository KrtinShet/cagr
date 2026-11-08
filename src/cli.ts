import { resolve } from "node:path";
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
import { loadRules, RuleError, testRules } from "./rules/rules";
import { GitSetupError, installGitHooks, sync } from "./sync";
import { version } from "./version";

const help = `guardwright ${version}: one config for every coding agent's guardrails.

Usage: guardwright <command>

  init [--dry-run] [--force]   Detect the repo, write guardwright.toml, the agent hooks and the git hooks.
  sync [--check]               Rewrite the generated agent and git hook files. --check fails on drift.
  install-git-hooks            Write the git hooks and set core.hooksPath.
  doctor                       Check the wiring, the tools each check needs, and hook timings.
  check <files...>             Run the edit checks and code rules on files.
  explain <id>                 Explain a guard or a code rule.
  rules test                   Check every rule's examples: invalid ones must fire, valid ones must not.
  schema                       Print the JSON schema for guardwright.toml.
  hook <event> --agent <name>  Called by agent hooks: reads the agent's JSON on stdin.
  git <hook> [args]            Called by git hooks: ${gitHookNames.join(", ")}.

Events: ${agentEvents.join(", ")}. Agents: ${agentNames.join(", ")}.`;

class UsageError extends Error {}

function requireConfig(): Config {
	const config = loadConfig(process.cwd());
	if (!config)
		throw new UsageError(
			"No guardwright.toml (or [tool.guardwright] in pyproject.toml) here or above. Run `guardwright init`.",
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

async function main(argv: string[]): Promise<number> {
	const [command, ...args] = argv;
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
					`guardwright: the ${hook} hook did not run. ${(error as Error).message}`,
				);
				return 0;
			}
			if (!config) return 0;
			const result =
				hook === "commit-msg"
					? commitMsg(args[1] ?? ".git/COMMIT_EDITMSG", config)
					: await prePush(await Bun.stdin.text(), config, process.cwd());
			for (const message of result.messages)
				console.error(`guardwright: ${message}`);
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
				`${dryRun ? "Would write" : "Wrote"} guardwright.toml:\n\n${result.config}`,
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
			if (check) {
				if (result.drifted.length === 0) {
					console.log("Generated files are up to date.");
					return 0;
				}
				console.error(
					`Out of date: ${result.drifted.join(", ")}. Run \`guardwright sync\`.`,
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
			const result = await doctor(requireConfig());
			console.log(result.report);
			return result.ok ? 0 : 1;
		}
		case "check": {
			if (args.length === 0)
				throw new UsageError(
					"Name the files to check: guardwright check <files...>",
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
			const rules = config ? loadRules(config) : [];
			const rule = rules.find((entry) => entry.id === id);
			if (!rule) {
				console.error(
					`No guard or rule "${id ?? ""}". Known: ${[...guards.map((g) => g.id), ...rules.map((r) => r.id)].join(", ")}.`,
				);
				return 1;
			}
			console.log(
				[
					`${rule.id} (${rule.language} rule from ${rule.source})`,
					"",
					`Message: ${rule.message}`,
					`Instead: ${rule.instead}`,
					...(rule.note ? [`Note: ${rule.note}`] : []),
					"",
					"Fires on:",
					...rule.examples.invalid.map((example) => `  ${example}`),
					"Allows:",
					...rule.examples.valid.map((example) => `  ${example}`),
				].join("\n"),
			);
			return 0;
		}
		case "rules": {
			if (args[0] !== "test")
				throw new UsageError("Usage: guardwright rules test");
			const rules = loadRules(requireConfig());
			const results = await testRules(rules);
			for (const result of results.filter((entry) => !entry.ok))
				console.log(
					`FAIL ${result.rule}: ${result.kind} example ${result.kind === "invalid" ? "did not fire" : `fired ${result.matches} time${result.matches === 1 ? "" : "s"}`}:\n  ${result.example.trim().replace(/\n/g, "\n  ")}`,
				);
			const failed = results.filter((entry) => !entry.ok).length;
			console.log(
				`${rules.length} rules, ${results.length} examples, ${failed} failed.`,
			);
			return failed === 0 ? 0 : 1;
		}
		case "schema":
			console.log(JSON.stringify(jsonSchema(), null, "\t"));
			return 0;
		default:
			throw new UsageError(`Unknown command "${command}".\n\n${help}`);
	}
}

const expected = (error: unknown) =>
	error instanceof UsageError ||
	error instanceof GitSetupError ||
	error instanceof ConfigError ||
	error instanceof RuleError;

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
