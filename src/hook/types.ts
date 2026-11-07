export const agentEvents = [
	"session.start",
	"command.before",
	"file.before_edit",
	"file.after_edit",
	"turn.end",
] as const;
export type AgentEvent = (typeof agentEvents)[number];

/** What an agent's hook payload means, whichever agent sent it. */
export type HookInput = {
	event: AgentEvent;
	sessionId: string;
	cwd: string;
	command: string | null;
	/** Absolute paths. */
	files: string[];
};

/**
 * `deny` stops a tool call before it runs. `block` sends the agent back to
 * work after a tool call or a stop. `notice` is for the human.
 */
export type Decision =
	| { kind: "allow"; context?: string; notice?: string }
	| { kind: "deny"; reason: string }
	| { kind: "block"; reason: string; notice?: string };
