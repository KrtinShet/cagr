import { accessSync, constants, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { checkChanges } from "./changes/check";
import { testChanges } from "./changes/rules";
import type { Config } from "./config/schema";
import { githubLines } from "./doctor-github";
import { gitHookNames } from "./git-hooks";
import { configuredGuards } from "./guards/catalog";
import { readTimings } from "./hook/timings";
import { matchesGlob, toPosix } from "./paths";
import { pickAgent } from "./review/agent";
import type { Gh } from "./review/github";
import { loadRuleSet } from "./rules/rules";
import { run } from "./run";
import { isGitRepo, notGitRepo, sync } from "./sync";

export const budgetsMs: Record<string, number> = {
	"command.before": 50,
	"file.before_edit": 50,
	"file.after_edit": 1000,
	"turn.end": 60_000,
};

type Line = { ok: boolean; text: string };

const valueFlags = new Set([
	"--project",
	"-C",
	"--cwd",
	"--prefix",
	"--directory",
]);

/**
 * What must exist for a check to start: the runner, and the tool behind
 * `bunx`, `npx`, `pnpm exec`, `uv run` or `poetry run`. Package scripts and
 * `uvx`, which fetches its tool, need only the runner.
 */
export function programsOf(
	command: string,
): { name: string; dirs: string[] }[] {
	const words = command.split(/\s+/).filter((word) => word !== "");
	const runner = words[0] ?? "";
	const needed = [{ name: runner, dirs: [] as string[] }];
	const viaNode =
		runner === "bunx" ||
		runner === "npx" ||
		(runner === "pnpm" && words[1] === "exec");
	const viaPython =
		(runner === "uv" || runner === "poetry") && words.includes("run");
	if (!viaNode && !viaPython) return needed;
	let project = ".";
	let index = 1;
	for (; index < words.length; index++) {
		const word = words[index] as string;
		if (valueFlags.has(word)) project = words[++index] ?? ".";
		else if (!word.startsWith("-") && word !== "run" && word !== "exec") break;
	}
	const tool = words[index];
	if (tool)
		needed.push({
			name: tool,
			dirs: viaNode
				? ["node_modules/.bin"]
				: [join(project, ".venv/bin"), ".venv/bin"],
		});
	return needed;
}

const available = (program: { name: string; dirs: string[] }, root: string) =>
	Bun.which(program.name) !== null ||
	program.dirs.some((dir) => existsSync(join(root, dir, program.name)));

export async function doctor(
	config: Config,
	options: { github?: Gh } = {},
): Promise<{ ok: boolean; report: string }> {
	const sections: [string, Line[]][] = [];
	const configLines: Line[] = [{ ok: true, text: `Config: ${config.source}` }];
	const fragments = config.sources.slice(1);
	if (fragments.length > 0)
		configLines.push({
			ok: true,
			text: `Also config: ${fragments.map((file) => toPosix(relative(config.root, file))).join(", ")}`,
		});
	try {
		const rules = loadRuleSet(config);
		configLines.push({
			ok: true,
			text: `${rules.code.length} code rule${rules.code.length === 1 ? "" : "s"} loaded.`,
		});
		if (rules.layout.length > 0)
			configLines.push({
				ok: true,
				text: `${rules.layout.length} layout rule${rules.layout.length === 1 ? "" : "s"} loaded.`,
			});
	} catch (error) {
		configLines.push({ ok: false, text: (error as Error).message });
	}
	if (config.changes.rules.length) {
		for (const example of testChanges(config.changes.rules))
			if (!example.ok)
				configLines.push({
					ok: false,
					text:
						"Change rule " +
						example.rule +
						": fix the " +
						example.kind +
						" fixture.",
				});
		const tracked = await run(["git", "ls-files", "-z"], config.root);
		if (tracked.ok)
			for (const rule of config.changes.rules) {
				if (
					!tracked.stdout
						.split("\0")
						.filter(Boolean)
						.some(
							(path) =>
								rule.paths.some((pattern) => matchesGlob(pattern, path)) &&
								!rule.ignores.some((pattern) => matchesGlob(pattern, path)),
						)
				)
					configLines.push({
						ok: true,
						text: `Advice: ${rule.id} selects no tracked paths; keep it if it is for future files.`,
					});
			}
		const result = await checkChanges(config);
		configLines.push({
			ok: result.ok,
			text: !result.ok
				? result.output
				: "Change baseline: " +
					result.snapshot?.base +
					"; collection " +
					result.collectionMs.toFixed(1) +
					" ms, evaluation " +
					result.evaluationMs.toFixed(1) +
					" ms.",
		});
	}
	sections.push(["Config", configLines]);
	sections.push([
		"Guards",
		configuredGuards(config).map((guard) => ({
			ok: true,
			text: `${guard.id}: ${guard.summary ?? `off (configure ${guard.config})`}`,
		})),
	]);

	sections.push([
		"Change rules",
		config.changes.rules.map((rule) => ({
			ok: true,
			text: `${rule.id} (${rule.kind}): ${rule.reason}`,
		})),
	]);
	const wiring: Line[] = [];
	try {
		const result = sync(config, { check: true });
		for (const file of result.unchanged)
			wiring.push({ ok: true, text: `${file} is up to date.` });
		for (const file of result.drifted)
			wiring.push({
				ok: false,
				text: `${file} is missing or out of date. Run \`cagr sync\`.`,
			});
	} catch (error) {
		wiring.push({ ok: false, text: (error as Error).message });
	}
	const hooksPath = (
		await run(["git", "config", "--get", "core.hooksPath"], config.root)
	).output.trim();
	if (!(await isGitRepo(config.root)))
		wiring.push({ ok: false, text: notGitRepo });
	else if (hooksPath === config.git.hooks_path)
		wiring.push({
			ok: true,
			text: `core.hooksPath is ${config.git.hooks_path}.`,
		});
	else
		wiring.push({
			ok: false,
			text: `${hooksPath ? `core.hooksPath is ${hooksPath}, not ${config.git.hooks_path}` : "core.hooksPath is not set"}, so git does not run cagr's hooks. Run \`cagr install-git-hooks\`.`,
		});
	for (const hook of gitHookNames) {
		const file = join(config.root, config.git.hooks_path, hook);
		try {
			accessSync(file, constants.X_OK);
		} catch {
			if (existsSync(file))
				wiring.push({
					ok: false,
					text: `${config.git.hooks_path}/${hook} is not executable. Run \`cagr install-git-hooks\`.`,
				});
		}
	}
	sections.push(["Wiring", wiring]);

	const tools: Line[] = [];
	const program = config.agents.command.split(" ")[0] ?? "cagr";
	if (!program.includes("{") && !program.includes("$"))
		tools.push(
			Bun.which(program)
				? { ok: true, text: `${program} is on PATH, so hooks can run it.` }
				: {
						ok: false,
						text: `${program} is not on PATH. Hooks call it; install it or set [agents] command.`,
					},
		);
	const commands = [
		...new Set([
			...config.stack.flatMap((stack) => [
				...stack.on_edit,
				...stack.on_turn_end,
			]),
			...config.git.pre_push,
		]),
	];
	for (const command of commands) {
		const missing = programsOf(command)
			.filter((program) => !available(program, config.root))
			.map((program) => program.name);
		tools.push(
			missing.length === 0
				? { ok: true, text: `\`${command}\`` }
				: {
						ok: false,
						text: `\`${command}\`: ${missing.join(", ")} not found.`,
					},
		);
	}
	sections.push(["Tools", tools]);

	if (config.review.enabled) {
		const review: Line[] = [];
		try {
			const agent = pickAgent(config.review.reviewer);
			review.push({ ok: true, text: `Reviewer: ${agent.name}.` });
		} catch (error) {
			review.push({ ok: false, text: `${(error as Error).message}.` });
		}
		review.push(
			existsSync(join(config.root, config.review.guide))
				? {
						ok: true,
						text: `${config.review.guide} is read into every review.`,
					}
				: {
						ok: true,
						text: `No ${config.review.guide}. Optional: write what reviewers should check in this repo, and what to skip.`,
					},
		);
		review.push({
			ok: true,
			text: `Gate: ${config.review.gate.map((match) => `\`${match}\``).join(", ") || "none"}. Effort ${config.review.effort}, up to ${config.review.max_rounds} rounds.`,
		});
		sections.push(["Review", review]);
	}
	if (options.github)
		sections.push(["GitHub", await githubLines(config, options.github)]);

	const timing: Line[] = [];
	const recorded = readTimings(config.root);
	if (recorded.length === 0)
		timing.push({
			ok: true,
			text: "No hook runs recorded yet. Timings appear after the agent uses the hooks.",
		});
	const groups = new Map<string, number[]>();
	for (const entry of recorded) {
		const key = `${entry.event}\t${entry.check}`;
		groups.set(key, [...(groups.get(key) ?? []), entry.ms]);
	}
	for (const [key, values] of [...groups].sort()) {
		const [event, check] = key.split("\t") as [string, string];
		const sorted = [...values].sort((a, b) => a - b);
		const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
		const max = sorted.at(-1) ?? 0;
		const budget = budgetsMs[event];
		const over = check === "total" && budget !== undefined && median > budget;
		timing.push({
			ok: !over,
			text: `${event} ${check === "total" ? "(whole hook)" : `\`${check}\``}: median ${median} ms, max ${max} ms over ${values.length} runs${over ? `, over the ${budget} ms budget` : ""}.`,
		});
	}
	sections.push(["Timing", timing]);

	const ok = sections.every(([, lines]) => lines.every((line) => line.ok));
	const report = sections
		.map(
			([title, lines]) =>
				`${title}\n${lines.map((line) => `  ${line.ok ? "ok  " : "FAIL"} ${line.text}`).join("\n")}`,
		)
		.join("\n\n");
	return { ok, report };
}
