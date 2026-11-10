---
title: How cagr differs
nav_order: 2
---

# How cagr differs from linters and other tools

A linter checks code. cagr checks what a coding agent does (its commands, edits, stops and pull requests) and makes it run and obey your linters.

## The short version

|                      | Linters (ESLint, Biome, Ruff, tsc) | cagr                                                                                  |
| -------------------- | ---------------------------------- | ------------------------------------------------------------------------------------- |
| What it checks       | Source files.                      | Actions: shell commands, edit targets, the end of a turn, `gh pr create`, git pushes. |
| When it runs         | When someone runs it.              | At the agent's own events: before a command, before and after an edit, at turn end.   |
| What it can do       | Report problems.                   | Deny a command or edit, make the agent keep working, hold a pull request.             |
| Who reads the output | A person.                          | The agent. Every message says what to do instead, so the next try is right.           |
| Scope                | The files you point it at.         | The files the agent changed in this turn, with output deduped and cut short.          |
| Config               | One per tool, one per language.    | One `cagr.toml` for every agent and every language in the repo.                       |

## What a linter cannot see

Most of what goes wrong with an agent leaves no trace in the code for a linter to find:

- `npm install` in a bun repo. The lockfile changes, the code does not.
- `git push origin main`, `git push --force`, `git commit --no-verify`.
- An edit to `.env` or a lockfile.
- Stopping and saying "done" while `tsc` is still red.
- Opening a pull request nobody has reviewed, or merging one.
- `prisma db push` when the repo uses migrations.

cagr stops each of these before it happens, or before the agent can call the work finished. See [Guards](guards.md) for the full list.

## Where cagr and your linters meet

cagr does not replace Biome, ESLint, Ruff, mypy or your tests. It runs them at the moment they help the agent most:

- **After each edit**, your `on_edit` commands run on the files it changed, and only those. The agent fixes a problem while the file is still in its head, not forty edits later.
- **At the end of a turn**, your `on_turn_end` commands (type check, lint, tests) must pass before the agent may stop. It blocks at most 2 stops in a row, then lets the agent go and tells the human.
- **In CI**, `cagr ci` runs the same checks on the branch's changed files, so a change made without the hooks cannot merge.

Keep a rule in your linter when your linter can express it. cagr's [code rules](code-rules.md) are for the rest: repo-specific patterns your linter has no rule for, written as ast-grep with a required `instead:` and tested examples. Layout rules check file names and folders, which most linters do not.

## Compared with other tools

**pre-commit, husky, lefthook.** These run checks at commit time. That is too late for an agent: by the commit it may have made dozens of edits on a wrong path, and it can skip the hook with `--no-verify`. cagr writes git hooks too (`commit-msg`, `pre-push`), as the floor that covers any agent and any human, and it blocks `--no-verify` before the command runs.

**CI.** CI catches the problem after the push, minutes later, in a log the agent may never read. cagr catches it in the turn where it happened. `cagr ci` is still there as the backstop.

**AGENTS.md and CLAUDE.md.** Instructions are advice. An agent can miss them, forget them halfway through a long session, or decide they do not apply. cagr gives the agent the same rules as a short brief at session start, then enforces them.

**Hand-written agent hooks.** Claude Code and Codex both let you write hook scripts. cagr is those hooks, written once: one config for both agents, guards with tests, time budgets so the agent is not slowed down, and fail-open so a bug in a hook never stops the agent.

**AI review bots.** A bot that comments on a pull request reviews after the fact. `cagr review` runs before the pull request exists, in a fresh context, and the gate keeps `gh pr create` from running until every Important finding is fixed or answered. Answers and evals let you measure the reviewer's noise. See [Review](review.md).

**Sandboxes.** A sandbox limits what an agent is able to do. cagr guides an agent that is trying to do the right thing and slips. It is not a security boundary: see [Limits](limits.md). Use both if you need both.
