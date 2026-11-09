import { arr, bool, type Node, num, obj, oneOf, str } from "./schema-dsl";

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

export const riskTiers = ["low", "medium", "high"] as const;
export type RiskTier = (typeof riskTiers)[number];
export const efforts = ["quick", "standard", "deep"] as const;
export type Effort = (typeof efforts)[number];

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
				description: "Agents whose hook files `cagr sync` writes.",
			}),
			command: str({
				description:
					'How the generated hook files call cagr. "{root}" becomes the repo root for each agent.',
			}),
			nested_docs: bool({
				description:
					"Write a CLAUDE.md that imports AGENTS.md next to every AGENTS.md that has no CLAUDE.md.",
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
	layout: arr(
		obj(
			{
				id: str({
					minLength: 1,
					description:
						"A unique name, shown in each finding. `cagr explain <id>` prints the rule.",
				}),
				files: strings(
					"Globs, relative to the repo root, of the files this rule checks.",
				),
				ignores: strings("Globs of files this rule skips."),
				name: str({
					minLength: 1,
					description:
						"A regular expression the file name must match, without its extensions: `user-card` for user-card.test.tsx.",
				}),
				allowed: strings(
					"Globs where the files may live. A matching file outside all of them is a finding.",
				),
				message: str({
					minLength: 1,
					description: "What is wrong. Shown to the agent.",
				}),
				instead: str({
					minLength: 1,
					description: "What to do instead, so the agent can fix it.",
				}),
			},
			{ required: ["id", "files", "message", "instead"] },
		),
		{
			description:
				"Layout rules: file names and where files may live. Checked when a file is created, after each edit, at turn end, and in `cagr check` and `cagr ci`.",
		},
	),
	review: obj(
		{
			enabled: bool({
				description:
					"Gate pull requests on a review by a reviewer agent in a fresh context.",
			}),
			gate: strings(
				"Commands that need a passing review of the current commit, matched like [commands] blocked.",
			),
			reviewer: str({
				minLength: 1,
				description:
					'"auto", "claude", "codex", or a command. A command gets {prompt_file} and {schema_file} and prints the findings as JSON.',
			}),
			model: str({
				description: "Model for the reviewer agent, if not its default.",
			}),
			guide: str({
				description:
					"The repo's review instructions, read into every review. Missing is fine.",
			}),
			effort: str({
				enum: efforts,
				description:
					"quick: one finder. standard: a bug finder, a security finder and a verifier. deep: three finders and three voting verifiers. High-risk changes always get deep.",
			}),
			security: bool({
				description: "Run a security finder in standard and deep reviews.",
			}),
			max_rounds: num({
				min: 1,
				description:
					"After this many rounds the reviewer asks the author to step back and rethink the approach.",
			}),
			timeout_seconds: num({
				min: 30,
				description: "How long one reviewer agent may run.",
			}),
			skip: strings("Globs the reviewer does not review."),
			pr_sections: strings(
				"Headings a pull request body must have. `gh pr create` without them is denied.",
			),
			agents_may_merge: bool({
				description:
					"Let agents run `gh pr merge` and `gh pr review --approve`. Off: approval stays with a person.",
			}),
		},
		{ description: "The review gate and the reviewer agent." },
	),
	risk: obj(
		{
			default: str({
				enum: riskTiers,
				description: "Tier of a file no [[risk.paths]] entry matches.",
			}),
			paths: arr(
				obj(
					{
						glob: str({
							minLength: 1,
							description: "Files this entry covers.",
						}),
						tier: str({ enum: riskTiers, description: "Their risk tier." }),
						owners: strings(
							"Code owners for these files, written to CODEOWNERS (@user or @org/team).",
						),
						reason: str({ description: "Why these files carry this tier." }),
					},
					{ required: ["glob", "tier"] },
				),
				{
					description:
						"A file takes the highest tier of the entries it matches. The change takes the highest tier of its files.",
				},
			),
		},
		{
			description:
				"Risk tiers set by the change, not the author. Low needs no approval, medium one, high two.",
		},
	),
	ci: obj(
		{
			github: bool({
				description:
					"`cagr sync` writes the GitHub workflow, the pull request template and CODEOWNERS.",
			}),
			review: bool({
				description:
					"The workflow reviews each pull request with `cagr review --ci`. Needs the ANTHROPIC_API_KEY secret.",
			}),
			nightly: strings(
				"Globs the workflow reviews every night with `cagr review --scan`, opening an issue for findings.",
			),
			install: str({
				description: "The shell command the workflow uses to install cagr.",
			}),
		},
		{ description: "CI." },
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
export type LayoutRule = {
	id: string;
	files: string[];
	ignores: string[];
	name: RegExp | null;
	allowed: string[];
	message: string;
	instead: string;
};
export type RiskPath = {
	glob: string;
	tier: RiskTier;
	owners: string[];
	reason: string | null;
};

export type Config = {
	root: string;
	source: string;
	extends: string[];
	agents: { enabled: AgentName[]; command: string; nested_docs: boolean };
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
	layout: LayoutRule[];
	review: {
		enabled: boolean;
		gate: string[];
		reviewer: string;
		model: string | null;
		guide: string;
		effort: Effort;
		security: boolean;
		max_rounds: number;
		timeout_seconds: number;
		skip: string[];
		pr_sections: string[];
		agents_may_merge: boolean;
	};
	risk: { default: RiskTier; paths: RiskPath[] };
	ci: {
		github: boolean;
		review: boolean;
		nightly: string[];
		install: string;
	};
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
