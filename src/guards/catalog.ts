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
			"A [review] gate command (by default `gh pr create` and `gh pr ready`, also spelled `gh pr new`, with flags before the subcommand, or through `gh api`) when the branch's commit has no review, or the review left an Important finding open. With --head or `gh pr ready <branch>` it checks that branch. A `gh pr ready` that names a number or URL, or a `gh api` call for another branch or one it cannot tell, is denied with a note to run the command from the pull request's branch. So is a gate command after anything on the same line but `git add`, `git push`, `git status`, `git fetch`, `git diff` or `git log`. One literal `cd <path> &&` may start the line, and the gate then runs in that folder. A review that could not run lets the command through and tells the human, unless earlier findings are still open.",
		fix: 'Run `cagr review`, then fix each finding or answer it with `cagr review answer <id> --wrong|--intentional|--minor "<why>"`.',
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
			"`gh pr merge`, `gh pr review --approve`, and the merge, auto-merge and approve calls through `gh api`. With review on, resolving a review thread through `gh api`. A `gh alias set` that names any of these or a gate command, and `gh alias import`.",
		fix: "Say the pull request is ready and let a person approve and merge it. Reply on a review thread instead of resolving it.",
		config: "[review] agents_may_merge, enabled",
	},
];

export const guardIds = guards.map((guard) => guard.id);
