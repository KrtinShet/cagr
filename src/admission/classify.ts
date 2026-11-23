import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../config/schema";
import { shellQuote } from "../run";
import {
	programName,
	programWords,
	simpleCommands,
	withoutHeredocBodies,
} from "../shell";
import { supportsAdmission } from "./pressure";

const managers = ["bun", "npm", "pnpm", "yarn"];
export const defaultMedium = [
	"tsc",
	"pytest",
	"python -m pytest",
	"uv run pytest",
	"go test",
	"cargo test",
	"vitest run",
	"vitest",
	"bun x tsc",
	"bun tsc",
	"pnpm tsc",
	"yarn tsc",
	"bunx tsc",
	"npx tsc",
	"pnpm exec tsc",
	...managers.flatMap((manager) => [
		`${manager} test`,
		`${manager} run test`,
		`${manager} run check-types`,
		`${manager} run typecheck`,
	]),
];
export const defaultHeavy = [
	"docker compose up",
	"docker-compose up",
	"docker build",
	"docker run",
	"docker compose build",
	"docker-compose build",
	...managers.flatMap((manager) => [
		`${manager} run verify`,
		`${manager} run e2e`,
		`${manager} run test:e2e`,
	]),
	...["bun", "pnpm", "yarn"].flatMap((manager) => [
		`${manager} verify`,
		`${manager} e2e`,
		`${manager} test:e2e`,
	]),
];

export type CommandClass = "light" | "medium" | "heavy";
type Classification = { kind: CommandClass; pattern: string };
const rank = { light: 0, medium: 1, heavy: 2 };
const commandLimit = 200;

const wordsOf = (line: string, limit?: number) =>
	simpleCommands(withoutHeredocBodies(line), limit);

function normalized(words: string[]) {
	const program = programWords(words);
	return [programName(program), ...program.slice(1)];
}

function shellScript(argv: string[]) {
	const [program, flag, script] = normalized(argv);
	return /^(?:ba|da|z)?sh$/.test(program ?? "") &&
		/^-[a-z]*c[a-z]*$/.test(flag ?? "")
		? script
		: undefined;
}

const testOptionsWithValue = new Set([
	"--timeout",
	"--rerun-each",
	"--retry",
	"--seed",
	"--test-name-pattern",
	"--reporter",
	"--reporter-outfile",
	"--preload",
	"--import",
	"--require",
	"--config",
	"--coverage-reporter",
	"--coverage-dir",
	"-c",
	"-t",
	"-k",
	"-run",
]);

function oneTestFile(args: string[]) {
	const selectors: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] as string;
		if (arg === "--") {
			selectors.push(...args.slice(index + 1));
			break;
		}
		if (testOptionsWithValue.has(arg)) index++;
		else if (!arg.startsWith("-")) selectors.push(arg);
	}
	return (
		selectors.length === 1 &&
		/(?:\.(?:[cm]?[jt]sx?|py)|_test\.go)$/.test(selectors[0] ?? "")
	);
}

const managerOptionsWithValue = new Set([
	"--filter",
	"--filter-prod",
	"--workspace",
	"--cwd",
	"--dir",
	"-C",
	"--prefix",
	"--shell",
	"--script-shell",
	"--config",
	"--userconfig",
	"--registry",
	"--env-file",
	"--preload",
]);

function skipManagerOptions(words: string[], start: number) {
	let index = start;
	while (words[index]?.startsWith("-")) {
		const flag = words[index++];
		if (flag === "--") break;
		if (
			(flag && managerOptionsWithValue.has(flag)) ||
			(words[0] === "npm" && flag === "-w") ||
			(words[0] === "pnpm" && flag === "-F")
		)
			index++;
	}
	return index;
}

function normalizeManager(words: string[]) {
	const manager = words[0];
	if (!manager || !managers.includes(manager)) return words;
	let start = skipManagerOptions(words, 1);
	if (manager === "yarn" && words[start] === "workspace")
		start = skipManagerOptions(words, start + 2);
	const action = words[start];
	if (!action) return [manager];
	const args =
		action === "run" ? skipManagerOptions(words, start + 1) : start + 1;
	return [manager, action, ...words.slice(args)];
}

function packageScripts(cwd: string): Record<string, unknown> {
	for (let dir = cwd; ; dir = dirname(dir)) {
		try {
			const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
			return pkg?.scripts ?? {};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return {};
		}
		if (dirname(dir) === dir) return {};
	}
}

const directTests = new Set([
	"bun test",
	"vitest run",
	"vitest",
	"pytest",
	"python -m pytest",
	"uv run pytest",
	"go test",
	"cargo test",
]);

function classifier(config: Config["admission"], cwd?: string) {
	const patterns = (["light", "heavy", "medium"] as const).flatMap((kind) =>
		config[kind].map((pattern) => ({
			kind,
			pattern,
			prefix: wordsOf(pattern)[0],
		})),
	);
	const active = new Set<string>();
	let scripts: ReturnType<typeof packageScripts> | undefined;
	let remaining = commandLimit;

	function shell(line: string, direct: boolean): Classification {
		const commands = wordsOf(line, remaining + 1);
		if (commands.length > remaining) return { kind: "heavy", pattern: line };
		remaining -= commands.length;
		let best: Classification = { kind: "light", pattern: line };
		for (const words of commands) {
			const next = argv(words, direct);
			if (commands.length === 1) return next;
			if (rank[next.kind] > rank[best.kind])
				best = { kind: next.kind, pattern: line };
			if (best.kind === "heavy") break;
		}
		return best;
	}

	function argv(args: string[], direct = true): Classification {
		const script = shellScript(args);
		if (script !== undefined) return shell(script, direct);
		const words = normalizeManager(normalized(args));
		const [manager, action, name] = words;
		const shorthand =
			manager === "pnpm" || manager === "yarn" || manager === "bun";
		const named = action === "run" ? name : shorthand ? action : undefined;
		const explicit =
			shorthand && named && action !== "run"
				? [manager, "run", ...words.slice(1)]
				: undefined;
		const fallback: Classification = {
			kind: "light",
			pattern: words.map(shellQuote).join(" "),
		};
		for (const { kind, pattern, prefix } of patterns) {
			if (!prefix?.length) continue;
			const exact = prefix.every((word, i) => word === words[i]);
			if (!exact && !prefix.every((word, i) => word === explicit?.[i]))
				continue;
			if (
				direct &&
				exact &&
				kind === "medium" &&
				config.medium === defaultMedium &&
				directTests.has(pattern) &&
				oneTestFile(words.slice(prefix.length))
			)
				return fallback;
			return { kind, pattern };
		}
		if (
			!cwd ||
			!manager ||
			!managers.includes(manager) ||
			!named ||
			active.has(named)
		)
			return fallback;
		scripts ??= packageScripts(cwd);
		const body = scripts[named];
		if (typeof body !== "string") return fallback;
		active.add(named);
		const { kind } = shell(body, false);
		active.delete(named);
		return { kind, pattern: `${manager} run ${shellQuote(named)}` };
	}

	return argv;
}

export function classifyArgv(
	argv: string[],
	config: Config["admission"],
	cwd?: string,
): Classification {
	return classifier(config, cwd)(argv);
}

function wrappedArgv(words: string[], configured?: string[]) {
	const program = programWords(words);
	const offset =
		programName(program) === "cagr"
			? 1
			: configured?.every((word, i) => word === program[i])
				? configured.length
				: 0;
	return offset &&
		["run", "measure"].includes(program[offset] ?? "") &&
		program[offset + 1] === "--"
		? program.slice(offset + 2)
		: null;
}

function agentProgram(config: Config) {
	return wordsOf(config.agents.command)[0]?.map((word) =>
		word.replaceAll("{root}", config.root),
	);
}

export function wrappedCommands(line: string, config: Config): string[] {
	const configured = agentProgram(config);
	function unwrap(command: string): string[] {
		return wordsOf(command).flatMap((words) => {
			const argv = wrappedArgv(words, configured);
			if (!argv?.length) return [];
			const inner = shellScript(argv) ?? argv.map(shellQuote).join(" ");
			return [inner, ...unwrap(inner)];
		});
	}
	return unwrap(line);
}

export function admissionCommand(
	line: string,
	config: Config,
	cwd: string,
	originalArgv?: string[],
) {
	if (!supportsAdmission || !config.admission.enabled) return null;
	const commands = wordsOf(line, commandLimit + 1);
	const configured = agentProgram(config);
	const classify = classifier(config.admission, cwd);
	const needsWrapper =
		commands.length > commandLimit ||
		commands.some(
			(words) =>
				!wrappedArgv(words, configured) && classify(words).kind !== "light",
		);
	if (!needsWrapper) return null;
	const advice = originalArgv
		? originalArgv.map(shellQuote).join(" ")
		: commands.length === 1 &&
				programWords(commands[0] ?? [])
					.map(shellQuote)
					.join(" ") === line.trim()
			? line.trim()
			: `bash -c ${shellQuote(line)}`;
	const program = configured?.map(shellQuote).join(" ") || "cagr";
	return `${program} run -- ${advice}`;
}
