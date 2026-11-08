export type GuardInfo = {
	id: string;
	event: string;
	catches: string;
	fix: string;
	config: string;
};

export const guards: GuardInfo[] = [
	{
		id: "package-manager",
		event: "command.before",
		catches:
			"A package manager other than the one each [[stack]] names: npm, npx, pnpm, yarn, bun for JavaScript; pip, python -m pip, poetry, pipenv, uv for Python.",
		fix: "Run the same task with the chosen manager, for example `bun add x` instead of `npm install x`, or `uv add x` instead of `pip install x`.",
		config: "[[stack]] package_manager",
	},
	{
		id: "protected-branch",
		event: "command.before, git.pre_push",
		catches:
			"A push to the protected branch: by name, through HEAD while on it, as a refspec destination, a delete, or --all/--mirror.",
		fix: "Push your own branch and open a pull request.",
		config: "[git] protected_branch",
	},
	{
		id: "force-push",
		event: "command.before, git.pre_push",
		catches:
			"--force, --force-with-lease, -f in a flag group, and +refspecs. The pre-push hook also stops a push that is not a fast-forward.",
		fix: "Add commits on top instead of rewriting history. Ask a human if history really must change.",
		config: "[git] block_force_push",
	},
	{
		id: "hook-skip",
		event: "command.before",
		catches:
			"--no-verify (and `git commit -n`), changing or unsetting core.hooksPath, and setting the skip variable.",
		fix: "Fix what the hook reports. Restoring core.hooksPath to [git] hooks_path is allowed.",
		config: "[git] block_hook_skips, skip_env, hooks_path",
	},
	{
		id: "protected-file",
		event: "file.before_edit",
		catches:
			"An edit to a file that matches [files] protected and none of its except globs.",
		fix: "The entry's reason says what to do instead.",
		config: "[files] protected = [{ glob, except, reason }]",
	},
	{
		id: "blocked-command",
		event: "command.before",
		catches:
			"A command whose words contain an entry's match, in order. Quoted text and heredoc bodies do not count.",
		fix: "The entry's reason says what to run instead.",
		config: "[commands] blocked = [{ match, reason }]",
	},
	{
		id: "worktree-only",
		event: "command.before, file.before_edit",
		catches:
			"Edits, commits, switches and other changes in the main checkout. Reading git commands, fetch, pull and worktree are allowed.",
		fix: "Create a worktree inside [git] worktree_dir and work there.",
		config: "[git] worktree_only, worktree_dir (off by default)",
	},
	{
		id: "branch-name",
		event: "git.pre_push",
		catches: "A pushed branch whose name does not match [git] branch_name.",
		fix: "Rename the branch with `git branch -m <old> <new>` and push again.",
		config:
			'[git] branch_name = "type/name" | "off" | { pattern, example }, commit_types',
	},
	{
		id: "commit-message",
		event: "git.commit_msg",
		catches:
			"A commit subject that does not match [git] commit_message, or one over 72 characters.",
		fix: "Commit again with a subject like the example in the message.",
		config:
			'[git] commit_message = "conventional" | "off" | { pattern, example }, commit_types',
	},
	{
		id: "review-gate",
		event: "command.before",
		catches:
			"A [review] gate command (by default `gh pr create` and `gh pr ready`) when the current commit has no review, or the review left an Important finding open. A review that could not run lets the command through and tells the human.",
		fix: 'Run `guardwright review`, then fix each finding or answer it with `guardwright review answer <id> --wrong|--intentional|--minor "<why>"`.',
		config: "[review] enabled, gate, max_rounds",
	},
	{
		id: "pr-body",
		event: "command.before",
		catches:
			"`gh pr create` with --fill, no body, or a body that lacks a [review] pr_sections heading.",
		fix: "Pass --body or --body-file with a `## <section>` heading for each section, filled in.",
		config: "[review] pr_sections",
	},
	{
		id: "agent-approval",
		event: "command.before",
		catches:
			"`gh pr merge`, `gh pr review --approve`, and the merge, auto-merge and approve calls through `gh api`.",
		fix: "Say the pull request is ready and let a person approve and merge it.",
		config: "[review] agents_may_merge",
	},
];

export const guardIds = guards.map((guard) => guard.id);
