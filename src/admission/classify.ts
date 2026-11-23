import type { Config } from "../config/schema";
import { shellQuote } from "../run";
import {
	programName,
	programWords,
	simpleCommands,
	withoutHeredocBodies,
} from "../shell";

const managers = ["bun", "npm", "pnpm", "yarn"];
export const defaultMedium = [
	"tsc",
	"pytest",
	"python -m pytest",
	"uv run pytest",
	"go test",
	"cargo test",
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

const wordsOf = (line: string) => simpleCommands(withoutHeredocBodies(line));

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

export function classifyArgv(
	argv: string[],
	config: Config["admission"],
): Classification {
	const script = shellScript(argv);
	if (script !== undefined) return classifyShell(script, config);
	const words = normalized(argv);
	for (const kind of ["light", "heavy", "medium"] as const) {
		for (const pattern of config[kind]) {
			const prefix = wordsOf(pattern)[0];
			if (!prefix?.length || !prefix.every((word, i) => word === words[i]))
				continue;
			if (
				kind === "medium" &&
				config.medium === defaultMedium &&
				/(?:\btest|\bpytest)$/.test(pattern) &&
				oneTestFile(words.slice(prefix.length))
			)
				return { kind: "light", pattern: words.map(shellQuote).join(" ") };
			return { kind, pattern };
		}
	}
	return { kind: "light", pattern: words.map(shellQuote).join(" ") };
}

function classifyShell(
	line: string,
	config: Config["admission"],
): Classification {
	const commands = wordsOf(line);
	const classes = commands.map((words) => classifyArgv(words, config));
	const largest = classes.reduce<Classification>(
		(best, next) => (rank[next.kind] > rank[best.kind] ? next : best),
		{ kind: "light", pattern: classes[0]?.pattern ?? line },
	);
	return commands.length > 1 ? { ...largest, pattern: line } : largest;
}

function wrappedArgv(words: string[], config: Config) {
	const program = programWords(words);
	const configured = wordsOf(
		config.agents.command.replaceAll("{root}", config.root),
	)[0];
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

export function wrappedCommands(line: string, config: Config): string[] {
	return wordsOf(line).flatMap((words) => {
		const argv = wrappedArgv(words, config);
		if (!argv?.length) return [];
		const command = shellScript(argv) ?? argv.map(shellQuote).join(" ");
		return [command, ...wrappedCommands(command, config)];
	});
}

export function admissionFinding(line: string, config: Config) {
	if (!config.admission.enabled) return null;
	const commands = wordsOf(line);
	const needsWrapper = commands.some(
		(words) =>
			!wrappedArgv(words, config) &&
			classifyArgv(words, config.admission).kind !== "light",
	);
	if (!needsWrapper) return null;
	const advice =
		commands.length === 1 &&
		programWords(commands[0] ?? [])
			.map(shellQuote)
			.join(" ") === line.trim()
			? line.trim()
			: `sh -c ${shellQuote(line)}`;
	return {
		id: "admission",
		reason: `This command needs memory admission. Rerun as cagr run -- ${advice}`,
	};
}
