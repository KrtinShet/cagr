import type { AgentName } from "../config/schema";
import { editedFiles } from "../edited-files";
import type { AgentEvent, Decision, HookInput } from "./types";

const nativeEvent: Record<AgentEvent, string> = {
	"session.start": "SessionStart",
	"command.before": "PreToolUse",
	"file.before_edit": "PreToolUse",
	"file.after_edit": "PostToolUse",
	"turn.end": "Stop",
};

/** Claude Code and Codex send the same payload shape; Codex may send a command as argv. */
export function parseInput(
	_agent: AgentName,
	event: AgentEvent,
	payload: unknown,
	fallbackCwd: string,
): HookInput {
	const raw = (
		typeof payload === "object" && payload !== null ? payload : {}
	) as Record<string, unknown>;
	const cwd =
		typeof raw.cwd === "string" && raw.cwd !== "" ? raw.cwd : fallbackCwd;
	const toolInput = (raw.tool_input ?? {}) as Record<string, unknown>;
	const isEdit = event === "file.before_edit" || event === "file.after_edit";
	return {
		event,
		sessionId:
			typeof raw.session_id === "string" && raw.session_id !== ""
				? raw.session_id
				: "unknown",
		cwd,
		command: event === "command.before" ? commandText(toolInput.command) : null,
		files: isEdit ? editedFiles(toolInput, cwd) : [],
	};
}

function commandText(command: unknown): string | null {
	if (typeof command === "string") return command;
	if (
		!Array.isArray(command) ||
		!command.every((word) => typeof word === "string")
	)
		return null;
	const [program, flag, script] = command as string[];
	if (
		/(^|\/)(ba|z)?sh$/.test(program ?? "") &&
		/^-l?c$/.test(flag ?? "") &&
		script !== undefined
	)
		return script;
	return (command as string[])
		.map((word) =>
			/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`,
		)
		.join(" ");
}

/** The agent's hook output for a decision. Hooks always exit 0 and speak through JSON. */
export function renderDecision(
	_agent: AgentName,
	event: AgentEvent,
	decision: Decision,
): string {
	const hookEventName = nativeEvent[event];
	if (decision.kind === "deny")
		return JSON.stringify({
			hookSpecificOutput: {
				hookEventName,
				permissionDecision: "deny",
				permissionDecisionReason: cap(decision.reason),
			},
		});
	if (decision.kind === "block")
		return JSON.stringify({
			decision: "block",
			reason: cap(decision.reason),
			...(decision.notice ? { systemMessage: cap(decision.notice) } : {}),
		});
	if (decision.context && !decision.notice) return decision.context;
	const output: Record<string, unknown> = {};
	if (decision.notice) output.systemMessage = cap(decision.notice);
	if (decision.context)
		output.hookSpecificOutput = {
			hookEventName,
			additionalContext: cap(decision.context),
		};
	return Object.keys(output).length > 0 ? JSON.stringify(output) : "";
}

// Both agents cap hook text at 10,000 characters.
const limit = 9500;
const cap = (text: string) =>
	text.length <= limit ? text : `${text.slice(0, limit)}\n... (cut)`;
