import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, runShell, shellQuote } from "../run";

export type AgentRequest = {
	prompt: string;
	schema: object;
	cwd: string;
	timeoutMs: number;
	model: string | null;
};

/** Runs one reviewer agent and returns its structured answer. Throws with a message a person can act on. */
export type ReviewAgent = {
	name: string;
	ask(request: AgentRequest): Promise<unknown>;
};

export class ReviewerError extends Error {}

const readTools = [
	"Read",
	"Grep",
	"Glob",
	"Bash(git diff *)",
	"Bash(git log *)",
	"Bash(git show *)",
	"Bash(git blame *)",
	"Bash(git grep *)",
	"Bash(git ls-files *)",
];

// The reviewer's own guardwright hooks see this and stay out of its way.
const reviewerEnv = { GUARDWRIGHT_REVIEWER: "1" };

const claude: ReviewAgent = {
	name: "claude",
	async ask(request) {
		const argv = [
			"claude",
			"-p",
			"--output-format",
			"json",
			"--json-schema",
			JSON.stringify(request.schema),
			"--strict-mcp-config",
			"--disable-slash-commands",
			"--tools",
			"Read,Grep,Glob,Bash",
			...(request.model ? ["--model", request.model] : []),
			"--allowedTools",
			...readTools,
		];
		const result = await run(argv, request.cwd, {
			stdin: request.prompt,
			timeoutMs: request.timeoutMs,
			env: reviewerEnv,
		});
		if (result.timedOut)
			throw new ReviewerError(`claude ran past ${request.timeoutMs / 1000}s`);
		const final = claudeResult(result.output);
		if (!final)
			throw new ReviewerError(
				`claude printed no result (exit ${result.ok ? 0 : "non-zero"}): ${result.output.trim().slice(0, 300)}`,
			);
		if (final.is_error || final.structured_output === undefined)
			throw new ReviewerError(
				`claude failed: ${String(final.result ?? final.subtype ?? "no structured output").slice(0, 300)}`,
			);
		return final.structured_output;
	},
};

type ClaudeEvent = {
	type?: string;
	subtype?: string;
	is_error?: boolean;
	result?: unknown;
	structured_output?: unknown;
};

/** `claude -p --output-format json` prints one result object, or a list of events ending in one. */
export function claudeResult(output: string): ClaudeEvent | null {
	const start = output.search(/^[[{]/m);
	if (start === -1) return null;
	try {
		const parsed = JSON.parse(output.slice(start)) as
			| ClaudeEvent
			| ClaudeEvent[];
		const events = Array.isArray(parsed) ? parsed : [parsed];
		return events.findLast((event) => event.type === "result") ?? null;
	} catch {
		return null;
	}
}

const codex: ReviewAgent = {
	name: "codex",
	async ask(request) {
		const dir = mkdtempSync(join(tmpdir(), "guardwright-review-"));
		try {
			const schemaFile = join(dir, "schema.json");
			const outFile = join(dir, "out.json");
			writeFileSync(schemaFile, JSON.stringify(request.schema));
			const result = await run(
				[
					"codex",
					"exec",
					"--sandbox",
					"read-only",
					"--output-schema",
					schemaFile,
					"-o",
					outFile,
					...(request.model ? ["-m", request.model] : []),
					"-",
				],
				request.cwd,
				{
					stdin: request.prompt,
					timeoutMs: request.timeoutMs,
					env: reviewerEnv,
				},
			);
			if (result.timedOut)
				throw new ReviewerError(`codex ran past ${request.timeoutMs / 1000}s`);
			let text = "";
			try {
				text = readFileSync(outFile, "utf8");
			} catch {
				throw new ReviewerError(
					`codex wrote no answer: ${result.output.trim().slice(-300)}`,
				);
			}
			return parseJson(text, "codex");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
};

/** A repo's own reviewer: a shell command that prints the answer as JSON. */
export function commandAgent(command: string): ReviewAgent {
	return {
		name: command.split(" ")[0] ?? "command",
		async ask(request) {
			const dir = mkdtempSync(join(tmpdir(), "guardwright-review-"));
			try {
				const promptFile = join(dir, "prompt.md");
				const schemaFile = join(dir, "schema.json");
				writeFileSync(promptFile, request.prompt);
				writeFileSync(schemaFile, JSON.stringify(request.schema));
				const line = command
					.replaceAll("{prompt_file}", shellQuote(promptFile))
					.replaceAll("{schema_file}", shellQuote(schemaFile));
				const result = await runShell(line, request.cwd, {
					stdin: request.prompt,
					timeoutMs: request.timeoutMs,
					env: reviewerEnv,
				});
				if (!result.ok)
					throw new ReviewerError(
						`\`${command}\` failed: ${result.output.trim().slice(-300)}`,
					);
				return parseJson(result.output, `\`${command}\``);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	};
}

/** The last JSON object in `text`. */
export function parseJson(text: string, who: string): unknown {
	const trimmed = text.trim();
	try {
		return JSON.parse(trimmed);
	} catch {
		const fenced = [...trimmed.matchAll(/```(?:json)?\n([\s\S]*?)```/g)].at(
			-1,
		)?.[1];
		const candidate =
			fenced ??
			trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1);
		try {
			return JSON.parse(candidate);
		} catch {
			throw new ReviewerError(
				`${who} did not print JSON: ${trimmed.slice(0, 300)}`,
			);
		}
	}
}

export function pickAgent(
	setting: string,
	env: Record<string, string | undefined> = process.env,
	which: (name: string) => string | null = Bun.which,
): ReviewAgent {
	if (setting === "claude") return claude;
	if (setting === "codex") return codex;
	if (setting !== "auto") return commandAgent(setting);
	// Prefer the agent the author is already using, then whichever is installed.
	if (env.CLAUDECODE && which("claude")) return claude;
	if (
		Object.keys(env).some((key) => key.startsWith("CODEX_")) &&
		which("codex")
	)
		return codex;
	if (which("claude")) return claude;
	if (which("codex")) return codex;
	throw new ReviewerError(
		"no reviewer agent found. Install Claude Code (`claude`) or Codex (`codex`), or set [review] reviewer to a command",
	);
}
