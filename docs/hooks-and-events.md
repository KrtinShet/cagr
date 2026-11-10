---
title: Hooks and events
nav_order: 6
---

# Hooks and events

cagr hooks into each agent through the agent's own hook system, and into git through `commit-msg` and `pre-push` hooks. Every agent's events map onto five cagr events, so one config covers them all.

## The five events

| Event              | When                                | What cagr does                                                                                                                                                                  | Can stop the agent?                           |
| ------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `session.start`    | A session starts.                   | Gives the agent a short brief of the repo's rules.                                                                                                                              | No                                            |
| `command.before`   | Before a shell command runs.        | Runs the [command guards](guards.md): package manager, protected branch, force push, hook skips, blocked commands, worktree-only, the review gate, the PR body, agent approval. | Yes: denies the command.                      |
| `file.before_edit` | Before an edit tool writes a file.  | Runs the protected-file and worktree-only guards.                                                                                                                               | Yes: denies the edit.                         |
| `file.after_edit`  | After an edit tool wrote a file.    | Records the file, then runs the `on_edit` commands of each stack that covers it and the [code rules](code-rules.md), on that file only.                                         | Yes: tells the agent to fix the problems now. |
| `turn.end`         | The agent tries to finish its turn. | If files were edited this turn, runs the `on_turn_end` commands and the code rules.                                                                                             | Yes: the agent must keep going.               |

There are three kinds of answers:

- **Deny**, before a tool runs. The command or edit does not happen, and the agent reads the reason.
- **Block**, after an edit or at the end of a turn. The edit already happened, or the agent wants to stop. The agent reads the reason and keeps working.
- **Allow**, sometimes with context for the agent (the session brief) or a notice for the human (for example, that cagr hit an error).

### The session brief

At session start the agent gets the repo's rules in plain words, before it slips. For example:

```
cagr checks this repo. When it blocks something, its message says what to do instead.
- Package managers: bun for JavaScript.
- Git: never push to main, push a branch and open a pull request; branches look like feat/deal-pipeline; commit subjects look like "feat(deals): add pipeline board"; no force pushes; no --no-verify.
- Do not edit: .env*, {bun.lock,bun.lockb,package-lock.json,pnpm-lock.yaml,yarn.lock,uv.lock,poetry.lock,Pipfile.lock,Cargo.lock,go.sum}.
- typescript (**): after each edit `bunx biome check --write --no-errors-on-unmatched {files}` run on the changed files; before you finish `bun run lint`, `bun run check-types` must pass.
- Do not run: `prisma db push`.
- Before `gh pr create` or `gh pr ready`, commit and run `cagr review` (give it a 15 minute timeout). Fix or answer every Important finding. The pull request body needs these headings: Testing, Risk, How to revert.
- Do not merge or approve pull requests. A person does that.
```

It also lists the code rule ids, the worktree rule when it is on, and every line of the top-level `brief` list:

```toml
brief = ["Run the dev server with `bun run dev`, never `bun dev`."]
```

### After an edit

After each edit, cagr runs only on the files that changed. For each stack whose `paths` and `extensions` cover a changed file, it runs that stack's `on_edit` commands with `{files}` set to those files. Then it runs the code rules on them. Each `on_edit` command may take up to 10 seconds.

If something fails, the agent reads:

```
Your edit has problems. Fix them now.

## biome check --write {files}
...
```

Output is deduped and cut short, so the agent reads each problem once. Formatters that fix files in place (`--write`, `--fix`) just fix them, so the agent sees only what is left.

### End of turn

When the agent tries to stop, cagr checks whether any file was edited this turn. If not, it lets the agent stop right away. Otherwise:

1. It picks every stack with a changed file and collects their `on_turn_end` commands. A command that two stacks share runs once, on the files of both.
2. A command with `{files}` gets the changed files that still exist. It is skipped if there are none. A command without `{files}` runs once for the whole repo.
3. The commands run in parallel, each with a 60 second limit. The code rules run on the changed files too.
4. Output is focused on the changed files, so the agent sees the errors it caused first.

If a check fails, the agent may not stop:

```
You changed code this turn and `bun run lint` failed. Fix these before finishing.

## `bun run lint`
...
```

Each check's output is cut at 3,000 characters.

### The escape from blocked stops

cagr never traps an agent in a loop. It counts failing stops in a turn. It blocks the first two. On the third failing stop it lets the agent go and tells the human:

```
cagr: `bun run lint` still failing after 3 attempts. The agent was let go so it does not loop. Run the checks yourself before you merge.
```

The count resets when the agent stops cleanly or is let go.

## Claude Code and Codex

`cagr sync` writes the hook files. Each hook calls `cagr hook <event> --agent <name>`, which reads the agent's JSON on stdin and answers in the agent's format.

| cagr event         | Claude Code (`.claude/settings.json`)                        | Codex (`.codex/hooks.json`)                          | Hook timeout |
| ------------------ | ------------------------------------------------------------ | ---------------------------------------------------- | ------------ |
| `session.start`    | `SessionStart`                                               | `SessionStart`                                       | 10 s         |
| `command.before`   | `PreToolUse`, matcher `Bash`                                 | `PreToolUse`, matcher `^Bash$`                       | 10 s         |
| `file.before_edit` | `PreToolUse`, matcher `Edit\|Write\|MultiEdit\|NotebookEdit` | `PreToolUse`, matcher `^(apply_patch\|Edit\|Write)$` | 10 s         |
| `file.after_edit`  | `PostToolUse`, same matcher                                  | `PostToolUse`, same matcher                          | 60 s         |
| `turn.end`         | `Stop`                                                       | `Stop`                                               | 300 s        |

How the answers map:

- A deny becomes `hookSpecificOutput.permissionDecision` with the reason.
- A block becomes `{"decision": "block", "reason": ...}`.
- A notice for the human becomes `systemMessage`.
- Context for the agent becomes `additionalContext`.

Text sent back is capped at 9,500 characters.

For Codex, cagr also reads commands given as an argument list, including scripts run with `sh -c` or `bash -lc`, and the file paths inside an `apply_patch`.

Codex asks you to trust project hooks once. Open Codex in the repo and approve them with `/hooks`.

Other agents do not have cagr agent hooks yet. The [git hooks](#git-hooks) still cover them.

## Time budgets

A guard that slows the agent down gets turned off, so cagr keeps to budgets:

| Event              | Budget |
| ------------------ | ------ |
| `command.before`   | 50 ms  |
| `file.before_edit` | 50 ms  |
| `file.after_edit`  | 1 s    |
| `turn.end`         | 60 s   |

cagr records how long each hook and each command took, and keeps the last 200 timings in your temp folder. `cagr doctor` shows the median for each event and each command against its budget. Only a whole hook's median over budget fails the check. A slow single command is shown so you can speed it up, for example by passing `{files}` instead of checking the whole repo.

## Fail-open

If cagr itself fails, it lets the call through and says why. A bug in cagr, a broken config or a crash never stops your agent:

```
cagr is off for this call because of an error. <the error>
```

The human sees this notice, so the error is not silent. Fix the config (`cagr doctor` names the problem) and the next call is checked again.

Other fail-open cases:

- A folder with no `cagr.toml` (or `[tool.cagr]`) above it: every call is allowed.
- The git hooks with a broken config print "cagr: the <hook> hook did not run." and the error, then let git continue.
- The git hooks when the `cagr` program is not installed: they print a warning and let the commit or push through, so a teammate without cagr is not stuck.
- The review gate when the reviewer could not run. See [Review](review.md#fail-open).

## Git hooks

`cagr sync` writes two hooks to `[git] hooks_path` (`.githooks` by default), and `cagr init` or `cagr install-git-hooks` sets `git config core.hooksPath` to that folder. They cover any agent and any human, with or without agent hooks.

**commit-msg** checks the commit subject against `[git] commit_message`. See [commit-message](guards.md#commit-message).

**pre-push** checks each pushed ref:

1. A push to the protected branch is stopped ([protected-branch](guards.md#protected-branch)).
2. With `block_force_push`, a push that would drop commits on the remote is stopped ([force-push](guards.md#force-push)). If the clone has never fetched the remote commit, the hook cannot judge it and lets the server decide.
3. A branch whose name breaks `[git] branch_name` is stopped ([branch-name](guards.md#branch-name)).
4. If all refs pass, it runs the `[git] pre_push` commands in order. The first failure stops the push: "`bun run verify` failed, so the push was stopped." followed by its output.

Every failure ends with:

```
A human can skip this once with CAGR_SKIP=1.
```

### Skipping the git hooks

A human can skip both hooks once by setting the skip variable on the command:

```sh
CAGR_SKIP=1 git push
```

Any value other than empty or `0` skips. `[git] skip_env` changes the variable name. With `block_hook_skips`, agents may not set it, and may not use `--no-verify` or change `core.hooksPath` either.

## New findings mode

With `[findings] mode = "new"`, `file.before_edit` saves first-touch source below the existing temp session directory, outside the repo. It runs no tools. Files absent before the edit have an empty baseline. The saved source never advances, including after clean stops or the stop escape. Each checkout and session has separate baseline storage. Temp storage may be removed after a session ends.

After an edit, the configured command runs as usual, including its fixes. A failed supported ESLint or Ruff command gets read-only JSON checks of the final live source and the saved source, using stdin and the original filename. Baseline findings are cached. Findings match by rule, message, severity, column and unchanged lines from a bounded line diff. Repeated lines are treated conservatively as new; each baseline finding can match once. Only new findings block. An inherited-only allow tells the agent: "N existing findings in this file were left out; they were there before you started."

Missing baselines, malformed or incomplete reports, tool errors, stderr, timeouts, unsupported flags and unsupported commands retain the original failing result. Unexpected cagr errors still follow the normal fail-open policy. Comparison subprocesses each get at most 250 ms and share the remaining 900 ms edit-check deadline. A slow tool can therefore stay strict. Existing configured commands keep their existing timeout; this feature does not guarantee that arbitrary commands fit the 1 s budget.

The session brief lists commands eligible for comparison. Biome stays strict in v1 because its stdin path does not provide JSON diagnostics in 2.6.6. Every turn-end command and CI check stays strict, even when edit checks allow inherited findings. This mode neither creates suppressions nor claims that the repo is clean.

## Local decision counts

Hooks record deny, block, stop-escape, fail-open and old-findings decisions, plus session starts, beside local timing data. Each rule and target counts once per decision per hook call, even if several lines match. Targets contain a short file path or only a program and known subcommand; file contents, command arguments and error text are never saved. Session IDs are hashed. The third failed stop records stop-escape for the failing checks rather than another block.

Run `cagr stats [--days N] [--json]` for counts and retry hints. `[stats] enabled = false` turns recording off. Storage is bounded and best effort; write failures and concurrent writers never change the hook result. A busy writer can lose counts.
