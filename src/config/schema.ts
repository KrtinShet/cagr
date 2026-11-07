import { arr, bool, type Node, obj, oneOf, str } from "./schema-dsl";

export const agentNames = ["claude", "codex"] as const;
export type AgentName = (typeof agentNames)[number];

export const packageManagers = [
	"bun",
	"npm",
	"pnpm",
	"yarn",
	"uv",
	"pip",
	"poetry",
	"pipenv",
] as const;
export type PackageManager = (typeof packageManagers)[number];

const strings = (description: string) => arr(str(), { description });
const oneOrMore = (description: string) =>
	oneOf([str(), arr(str())], {
		hint: "must be a command string or a list of them.",
		description,
	});
const namePattern = (presets: string[], description: string) =>
	oneOf(
		[
			str({ enum: [...presets, "off"] }),
			obj(
				{
					pattern: str({
						description: "A regular expression the value must match.",
					}),
					example: str({
						description: "A valid value, shown in the block message.",
					}),
				},
				{ required: ["pattern", "example"] },
			),
		],
		{
			hint: `must be ${presets.map((p) => `"${p}"`).join(" or ")}, "off", or { pattern = "...", example = "..." }.`,
			description,
		},
	);

export const configSchema: Node = obj({
	$schema: str({
		description: "Path or URL of this JSON schema, for editors.",
	}),
	extends: arr(str(), {
		description:
			'Presets this config builds on. v0.1 has "recommended". Lists of tables add to the preset\'s; other values replace them.',
	}),
	agents: obj(
		{
			enabled: arr(str({ enum: agentNames }), {
				description: "Agents whose hook files `guardwright sync` writes.",
			}),
			command: str({
				description:
					'How the generated hook files call guardwright. "{root}" becomes the repo root for each agent.',
			}),
		},
		{ description: "Agent adapters." },
	),
	git: obj(
		{
			protected_branch: str({
				description:
					"Branch agents may not push to. Empty string turns the check off.",
			}),
			branch_name: namePattern(
				["type/name"],
				"Branch name rule, checked on push.",
			),
			commit_message: namePattern(
				["conventional"],
				"Commit subject rule, checked by the commit-msg hook.",
			),
			commit_types: strings(
				"Types allowed in branch names and commit subjects.",
			),
			pre_push: oneOrMore(
				"Commands the pre-push hook runs. A failure stops the push.",
			),
			block_force_push: bool({ description: "Block force pushes." }),
			block_hook_skips: bool({
				description:
					"Block --no-verify, changing core.hooksPath, and setting the skip variable.",
			}),
			skip_env: str({
				description:
					"Environment variable a human sets to skip the git hooks. Agents may not set it.",
			}),
			hooks_path: str({
				description: "Folder for the git hooks, set as core.hooksPath.",
			}),
			worktree_only: bool({
				description:
					"Keep the main checkout clean: agents edit and commit only in worktrees.",
			}),
			worktree_dir: str({
				description: "Folder inside the main checkout where worktrees live.",
			}),
		},
		{ description: "Git rules." },
	),
	stack: arr(
		obj(
			{
				language: str({
					minLength: 1,
					description: "typescript, javascript, python, go, rust, or any name.",
				}),
				package_manager: str({
					enum: packageManagers,
					description:
						"The only package manager agents may use for this ecosystem.",
				}),
				paths: strings("Globs, relative to the repo root, this stack covers."),
				extensions: strings(
					"File extensions this stack checks. Defaults depend on the language.",
				),
				on_edit: strings(
					"Commands run after each edit, on changed files only. {files} becomes their paths.",
				),
				on_turn_end: strings(
					"Commands run before the agent may end a turn that changed files here.",
				),
			},
			{ required: ["language"] },
		),
		{ description: "One entry per language area of the repo." },
	),
	files: obj(
		{
			protected: arr(
				obj(
					{
						glob: str({
							description:
								"A glob. Without a slash it matches the file name anywhere.",
						}),
						except: strings("Globs that stay editable."),
						reason: str({
							minLength: 1,
							description: "What to do instead. Shown to the agent.",
						}),
					},
					{ required: ["glob", "reason"] },
				),
			),
		},
		{ description: "Files agents may not edit." },
	),
	commands: obj(
		{
			blocked: arr(
				obj(
					{
						match: str({
							minLength: 1,
							description:
								"Words that, in order, inside one command, block it. Quotes and heredoc bodies are text, not commands.",
						}),
						reason: str({
							minLength: 1,
							description: "What to run instead. Shown to the agent.",
						}),
					},
					{ required: ["match", "reason"] },
				),
			),
		},
		{ description: "Commands agents may not run." },
	),
	rules: obj(
		{
			dirs: strings("Folders holding ast-grep rule files (*.yml)."),
		},
		{ description: "Custom code rules." },
	),
	brief: strings("Extra lines for the session start brief."),
});

export type NameRule = {
	pattern: RegExp;
	example: string;
	label: string;
	maxLength?: number;
	hint?: string;
};
export type Stack = {
	language: string;
	package_manager: PackageManager | null;
	paths: string[];
	extensions: string[];
	on_edit: string[];
	on_turn_end: string[];
};
export type ProtectedFile = { glob: string; except: string[]; reason: string };
export type BlockedCommand = { match: string; reason: string };

export type Config = {
	root: string;
	source: string;
	extends: string[];
	agents: { enabled: AgentName[]; command: string };
	git: {
		protected_branch: string | null;
		branch_name: NameRule | null;
		commit_message: NameRule | null;
		commit_types: string[];
		pre_push: string[];
		block_force_push: boolean;
		block_hook_skips: boolean;
		skip_env: string;
		hooks_path: string;
		worktree_only: boolean;
		worktree_dir: string;
	};
	stack: Stack[];
	files: { protected: ProtectedFile[] };
	commands: { blocked: BlockedCommand[] };
	rules: { dirs: string[] };
	brief: string[];
};

export const defaultCommitTypes = [
	"feat",
	"fix",
	"refactor",
	"perf",
	"test",
	"docs",
	"chore",
	"ci",
	"build",
	"revert",
];

export const defaultExtensions: Record<string, string[]> = {
	typescript: [
		"ts",
		"tsx",
		"mts",
		"cts",
		"js",
		"jsx",
		"mjs",
		"cjs",
		"json",
		"jsonc",
		"css",
	],
	javascript: ["js", "jsx", "mjs", "cjs", "json", "jsonc", "css"],
	python: ["py", "pyi"],
	go: ["go"],
	rust: ["rs"],
};
