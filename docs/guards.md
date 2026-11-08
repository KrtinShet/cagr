---
title: Guards
nav_order: 4
---

# Guards

A guard is a built-in check on a command, a file path, a branch or a commit subject. When a guard blocks something, the agent sees the reason followed by the guard's id, like this:

```
Do not push to main. Push your <type>/<short-kebab-name> branch and open a pull request. (cagr: protected-branch)
```

The reason always says what to do instead, so the agent can fix the slip on its next try. `cagr explain <id>` prints what a guard catches, the fix, and the config that controls it.

Guards run at these events (see [Hooks and events](hooks-and-events.md)):

- `command.before`: before the agent runs a shell command.
- `file.before_edit`: before the agent edits a file.
- `git.pre_push` and `git.commit_msg`: in the git hooks, for agents and humans alike.

| Guard                                 | Runs at                          | Config                                             | On by default?                               |
| ------------------------------------- | -------------------------------- | -------------------------------------------------- | -------------------------------------------- |
| [package-manager](#package-manager)   | command.before                   | `[[stack]] package_manager`                        | When a stack names a manager                 |
| [protected-branch](#protected-branch) | command.before, pre-push         | `[git] protected_branch`                           | When a branch is set (`recommended`: `main`) |
| [force-push](#force-push)             | command.before, pre-push         | `[git] block_force_push`                           | With `recommended`                           |
| [hook-skip](#hook-skip)               | command.before                   | `[git] block_hook_skips`, `skip_env`, `hooks_path` | With `recommended`                           |
| [protected-file](#protected-file)     | file.before_edit                 | `[files] protected`                                | With `recommended` (`.env*`, lockfiles)      |
| [blocked-command](#blocked-command)   | command.before                   | `[commands] blocked`                               | When you list commands                       |
| [worktree-only](#worktree-only)       | command.before, file.before_edit | `[git] worktree_only`, `worktree_dir`              | No                                           |
| [branch-name](#branch-name)           | pre-push                         | `[git] branch_name`, `commit_types`                | With `recommended`                           |
| [commit-message](#commit-message)     | commit-msg                       | `[git] commit_message`, `commit_types`             | With `recommended`                           |
| [review-gate](#review-gate)           | command.before                   | `[review] enabled`, `gate`, `max_rounds`           | With `recommended`                           |
| [pr-body](#pr-body)                   | command.before                   | `[review] pr_sections`                             | With `recommended`                           |
| [agent-approval](#agent-approval)     | command.before                   | `[review] agents_may_merge`, `enabled`             | Partly. See below.                           |

Command guards read the command the way a shell does. They split a line into simple commands at `;`, `&`, `|`, newlines, parentheses and backticks, so `&&`, `||` and pipes split too. Text in quotes and heredoc bodies is text, not a command. So `echo "npm install"` is fine. They are a guard against slips, not a sandbox: see [Limits](limits.md).

## package-manager

**Blocks** a package manager other than the one a `[[stack]]` names, for that ecosystem:

- JavaScript: `bun` and `bunx`, `npm` and `npx`, `pnpm` and `pnpx`, `yarn`.
- Python: `uv` and `uvx`, `pip` and `pip3` (also `python -m pip`), `poetry`, `pipenv`.

The guard only acts on an ecosystem where some stack names a manager. If only a JavaScript stack sets `package_manager = "bun"`, Python tools are not checked.

**Messages:**

```
This repo uses bun for JavaScript. Use bun or bunx instead of npm, npx, pnpm, pnpx, or yarn. (cagr: package-manager)
This repo uses uv for Python. Use uv (`uv add`, `uv run`, `uv pip`) instead of pip, pip3, poetry, or pipenv. (cagr: package-manager)
```

**Configure:** set `package_manager` on each `[[stack]]`. Leave it out to turn the check off for that ecosystem.

## protected-branch

**Blocks** a push to the protected branch: by name (`git push origin main`), through `HEAD` or `@` while you are on it, as the destination of a refspec (`feat/x:main`), a delete (`:main`), and `--all`, `--mirror` or `--branches`, which also push the protected branch. It runs before the command and again in the pre-push hook, so it also covers humans and agents without hooks.

**Messages:**

```
Do not push to main. Push your <type>/<short-kebab-name> branch and open a pull request. (cagr: protected-branch)
Push one branch at a time. --all and --mirror also push main.
```

The `<type>/<short-kebab-name>` part comes from your `branch_name` rule. Without one, it says "Push your feature branch".

**Configure:** `[git] protected_branch = "main"`. Set it to `""` to turn the check off.

## force-push

**Blocks** `--force`, `--force-with-lease` and the other `--force*` flags, `-f` alone or in a flag group (`-fu`), and `+` refspecs (`+feat/x`). The pre-push hook also stops a push that is not a fast-forward, which catches a force push however it was spelled.

**Messages:**

```
Force pushes are blocked for agents. Ask a human if history really must be rewritten. (cagr: force-push)
```

From the pre-push hook, for a push that is not a fast-forward:

```
<ref> on the remote has commits that this push would drop. Pull and rebase or merge, then push without force.
```

**Configure:** `[git] block_force_push = true`. It is `false` without a preset.

## hook-skip

**Blocks** ways an agent can skip the repo's git hooks:

- `--no-verify`, and `git commit -n`.
- Changing `core.hooksPath`, with `git -c core.hooksPath=...` or `git config core.hooksPath ...`, or unsetting it with `git config --unset core.hooksPath`. Setting it back to `[git] hooks_path` is allowed.
- Setting the skip variable (`CAGR_SKIP` by default) on a command.

**Messages:**

```
--no-verify skips the repo's git hooks. Fix what the hook reports instead. (cagr: hook-skip)
Changing core.hooksPath turns off the repo's git hooks. Fix what the hook reports instead.
CAGR_SKIP is for humans only. Fix what the hook reports instead.
```

**Configure:** `[git] block_hook_skips = true`. `skip_env` names the variable, and `hooks_path` names the folder that may be restored.

## protected-file

**Blocks** an edit to a file that matches a `[files] protected` glob and none of its `except` globs. It runs before the edit, so the file never changes.

**Message:** the entry's `reason`. With `recommended`:

```
Env files hold real values. Do not edit them; tell the user which key is missing. (cagr: protected-file)
Lockfiles are written by the package manager. Change dependencies with its add or remove command instead. (cagr: protected-file)
```

**Configure:**

```toml
[[files.protected]]
glob = "migrations/**"
reason = "Migrations are generated. Run `bun run db:migrate --name <change>` instead."
```

Write the `reason` as what to do instead. Entries add to the preset's, so you cannot remove `.env*` or the lockfiles by leaving them out. `cagr check <files...>` also runs this check, so you can test a glob.

This guard sees edits made with the agent's edit tools. An edit made through the shell (`sed -i`, `cat >`) is a command, not an edit. See [Limits](limits.md).

## blocked-command

**Blocks** a command that contains an entry's `match` words, in order and next to each other, inside one simple command. Text in quotes and heredoc bodies does not count. With `match = "prisma db push"`, `bunx prisma db push --force` is blocked, but `echo "prisma db push"` is not.

**Message:** the entry's `reason`:

```
Use `bun run db:migrate --name <change>`. (cagr: blocked-command)
```

**Configure:**

```toml
[[commands.blocked]]
match = "prisma db push"
reason = "Use `bun run db:migrate --name <change>`."
```

## worktree-only

Off by default. When on, the main checkout stays on its branch with a clean tree, and agents work in git worktrees under `worktree_dir`.

**Blocks**, in the main checkout:

- Every git subcommand except these, which read or fast-forward: `status`, `log`, `diff`, `show`, `fetch`, `pull`, `worktree`, `branch`, `rev-parse`, `remote`, `config`, `grep`, `blame`, `ls-files`, `cat-file`.
- File edits outside `worktree_dir`.

A command line that contains a `cd`, or a `git -C <dir>` command, is not checked, since it may run in a worktree.

**Messages:**

```
The main checkout stays on main with a clean tree. Work in a worktree: `git worktree add .worktrees/<name> -b <type>/<name>`, then cd into it. (cagr: worktree-only)
```

The edit message starts with "Edit in" a worktree and gives the same `git worktree add` command.

**Configure:**

```toml
[git]
worktree_only = true
worktree_dir = ".worktrees"
```

Add `.worktrees/` to `.gitignore`.

## branch-name

**Blocks**, in the pre-push hook, a push of a branch whose name does not match `[git] branch_name`. It does not check a detached `HEAD` or the protected branch.

**Message:**

```
cagr: Branch "fix-stuff" does not match <type>/<short-kebab-name>, for example feat/deal-pipeline. Rename it with `git branch -m fix-stuff <new-name>`. Types: feat fix refactor perf test docs chore ci build revert. (cagr: branch-name)
A human can skip this once with CAGR_SKIP=1.
```

**Configure:** `[git] branch_name = "type/name"`, `"off"`, or `{ pattern, example }`. `commit_types` sets the types. See [Name rules](configuration.md#name-rules).

`cagr ci` checks the branch name too.

## commit-message

**Blocks**, in the commit-msg hook, a commit whose subject (the first line) does not match `[git] commit_message`, or is longer than 72 characters with `"conventional"`. Subjects that start with `Merge `, `Revert `, `fixup! ` or `squash! ` are not checked.

**Messages:**

```
cagr: Commit subject "Added stuff." does not match <type>(<scope>): <summary>. Example: feat(deals): add pipeline board. Lowercase summary, no trailing period. Types: feat fix refactor perf test docs chore ci build revert. (cagr: commit-message)
cagr: Commit subject is 78 characters. Keep it to 72 or fewer; put detail in the body. (cagr: commit-message)
```

Like every git hook failure, these end with "A human can skip this once with CAGR_SKIP=1." See [Git hooks](hooks-and-events.md#git-hooks).

**Configure:** `[git] commit_message = "conventional"`, `"off"`, or `{ pattern, example }`, plus `commit_types`.

`cagr ci` checks the commit subjects on the branch too.

## review-gate

**Blocks** a `[review] gate` command (by default `gh pr create` and `gh pr ready`) when the branch's current commit has not passed a review. It also catches `gh pr new`, flags before the subcommand, and the same calls through `gh api`. With `--head <branch>`, it checks that branch instead of the current one.

The gate denies the command when:

- The branch has no review: "This branch has not been reviewed. Run `cagr review`. It starts a reviewer agent in a fresh context and takes a few minutes, so give the command a 15 minute timeout. Fix or answer what it finds, then run this command again."
- There are commits after the last review: "You committed after the last review (abc1234). Run `cagr review` ... It reviews only the new commits."
- Important findings are open. It lists them (`- f1 src/deals.ts:42  title`), then says: "Fix each one, commit, and run `cagr review` again", or answer them with `cagr review answer`. After `max_rounds` rounds it adds: "Step back: if findings keep coming, the approach may be wrong. Rethink it, or answer the findings and let a person decide."
- `HEAD` is detached. It says to `git switch <branch>` or pass `--head <branch>`.
- `--head` names a branch that does not exist locally.

The gate lets the command through when:

- The current commit passed: no Important finding is open.
- The last review could not run and no finding is open. The human sees: "cagr: the review of ... could not run (...), so this pull request goes out unreviewed. Review it yourself before you approve it." If earlier findings are still open, the gate still denies.
- The folder is not a git repo.

**Configure:** `[review] enabled = true` turns it on. `gate` lists the commands, matched like `[commands] blocked`. See [Review](review.md).

## pr-body

**Blocks** `gh pr create` (and `gh pr new`) when the body is missing one of the `[review] pr_sections` headings:

- with `--fill`, which writes the body from commits;
- with no body at all;
- with a `--body` or `--body-file` that lacks a `## <section>` heading.

`--web` (or `-w`) is allowed, since the body is written in the browser. A body read from stdin (`--body-file -`) or from a file that cannot be read is not checked.

**Messages:**

```
--fill writes the body from commits, without the sections reviewers need. Pass the body with --body or --body-file, with these headings filled in:

## Testing

## Risk

## How to revert (cagr: pr-body)
```

```
The body lacks "## Testing", "## Risk", "## How to revert". Pass the body with --body or --body-file, with these headings filled in: ...
```

With no body, the message starts "This pull request has no body."

**Configure:** `[review] pr_sections = ["Testing", "Risk", "How to revert"]`. An empty list turns the check off. `cagr ci` checks the pull request body too, and `cagr sync` writes a matching PR template when `[ci] github = true`.

## agent-approval

**Blocks** three kinds of commands:

- **Merge and approve**, when `[review] agents_may_merge = false`: `gh pr merge`, `gh pr review --approve`, and the merge, auto-merge and approve calls through `gh api`.
- **Resolving a review thread** through `gh api`, whenever review is on. A resolved thread counts as an answer to a finding in CI.
- **Aliases**, always: a `gh alias set` that names any of the commands above or a gate command, and `gh alias import`.

These commands match however gh is called: by its full path (`/opt/homebrew/bin/gh`, `./bin/gh`) or as `gh.exe`. The same goes for review-gate and pr-body.

**Messages:**

```
Agents do not merge pull requests here. Say the pull request is ready and let a person review and merge it. (cagr: agent-approval)
An agent's approval does not count here. Leave a comment with `gh pr review --comment` if you need to, and let a person approve.
Agents do not resolve review threads here: a resolved thread counts as an answer to the finding. Fix the finding, or reply on the thread saying why it is wrong, and let a person resolve it.
Agents do not set gh aliases for merging, approving, resolving threads or opening pull requests here. Run the gh command itself.
```

**Configure:** `[review] agents_may_merge = true` lets agents merge and approve. It is `true` without a preset and `false` with `recommended`. `[review] enabled = false` lets agents resolve threads.

## Code rules

Your own ast-grep rules run after each edit and at the end of a turn, not before. They are covered in [Code rules](code-rules.md). A rule id may not reuse a guard id.
