---
title: CLI reference
nav_order: 11
---

# CLI reference

```
cagr <command> [options]
```

These commands need a config: `sync`, `install-git-hooks`, `doctor`, `review`, `risk`, `ci`, `check` and `rules test`. Without one they say: "No cagr.toml (or [tool.cagr] in pyproject.toml) here or above. Run `cagr init`."

An option a command does not take is an error that lists the options it does take. `--help` or `-h` after a command prints the help.

| Command                                   | What it does                                                          |
| ----------------------------------------- | --------------------------------------------------------------------- |
| [`init`](#init)                           | Detect the repo, write the config, the agent hooks and the git hooks. |
| [`sync`](#sync)                           | Rewrite the generated files, or fail when they drift.                 |
| [`install-git-hooks`](#install-git-hooks) | Write the git hooks and set `core.hooksPath`.                         |
| [`doctor`](#doctor)                       | Check the config, the wiring, the tools, and hook timings.            |
| [`review`](#review)                       | Review the branch with a reviewer agent.                              |
| [`risk`](#risk)                           | The change's risk tier, the approvals it needs, and the owners.       |
| [`ci`](#ci)                               | In CI: the checks the hooks ran, on the branch's changed files.       |
| [`check`](#check)                         | Run the edit checks and code rules on files, or every file (`--all`). |
| [`explain`](#explain)                     | Explain a built-in guard, a code rule or a layout rule.               |
| [`rules test`](#rules-test)               | Test every rule's examples.                                           |
| [`schema`](#schema)                       | Print the JSON schema for `cagr.toml`.                                |
| [`hook`](#hook)                           | Called by the agent hooks.                                            |
| [`git`](#git)                             | Called by the git hooks.                                              |
| [`post-status`](#post-status)             | Called by the pre-push hook: sends the GitHub commit statuses.        |
| `help`                                    | Print the command list and the files cagr reads, `.cagr/` included. |
| `version`, `--version`                    | Print the version.                                                    |

## init

```
cagr init [--dry-run] [--force]
```

Detects the stacks, package managers, tools, agents and protected branch, writes a short `cagr.toml` and starter `.cagr/guards.toml` and `.cagr/risk.toml` (each only when missing), runs `sync`, writes a starter `.cagr/review.md` when review is on and no guide exists, formats the JSON it wrote with your `on_edit` commands, and installs the git hooks. See [Getting started](getting-started.md).

After detection, prints the resolved guard policies and per-stack edit and stop commands. Empty command slots say how to add checks.

- `--dry-run`: print the enforcement summary and config it would write. Write nothing.
- `--force`: overwrite an existing `cagr.toml`. Without it, `init` stops if the file exists. Files in `.cagr/` are never overwritten.

## sync

```
cagr sync [--check]
```

Rewrites the generated files from the config: the agent hook files, the git hooks, and with `[ci] github = true` the workflow, PR template and CODEOWNERS. Keeps your own hook entries and any user-owned file without the generated mark. See [Generated files](configuration.md#generated-files-and-cagr-sync).

- `--check`: write nothing. List the files that are out of date and exit 1 if there are any.

## install-git-hooks

```
cagr install-git-hooks
```

Writes the git hooks to `[git] hooks_path` and sets `git config core.hooksPath` to it. Run it inside a git repo, for example after `git init` or in a fresh clone.

## doctor

```
cagr doctor [--github]
```

Checks the config and code rules load (and lists the `.cagr/*.toml` fragments that joined the config), the generated files match, `core.hooksPath` is set and the hooks are executable, `cagr` and every command's program can be found, the review setup, and the median time of each hook against its budget. The Guards section lists every built-in guard id with its configured policy or an off note. Disabled guards do not fail the check. Prints `ok` or `FAIL` per line. Exits 1 if any line fails.

- `--github`: also check the protected branch's settings on GitHub through `gh`. See [CI](ci.md#check-branch-protection).

## review

```
cagr review [--base <branch>] [--full] [--effort quick|standard|deep]
cagr review --scan <globs...> [--issue]
cagr review --ci
cagr review answer <id> --wrong|--intentional|--minor "<why>"
cagr review status
cagr review stats
cagr review eval [--case <name>] [--effort quick|standard|deep]
cagr review help
```

| Form                                                  | What it does                                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `review`                                              | Review this branch's commits. After round 1, only the new ones.                                         |
| `--base <branch>`                                     | Compare with this base instead of the protected branch.                                                 |
| `--full`                                              | Review the whole branch, even if the commit was reviewed or earlier rounds exist.                       |
| `--effort <level>`                                    | Use this effort for this run.                                                                           |
| `--scan <globs...>`                                   | Review the tracked files that match, instead of the branch's commits.                                   |
| `--issue`                                             | With `--scan`: open a GitHub issue with the findings.                                                   |
| `--ci`                                                | In GitHub Actions: review the pull request and post the findings on it.                                 |
| `answer <id> --wrong\|--intentional\|--minor "<why>"` | Answer a finding instead of fixing it.                                                                  |
| `status`                                              | The branch's rounds and findings, and their state.                                                      |
| `stats`                                               | Rounds to pass and how findings were answered, across branches.                                         |
| `eval`                                                | Score the reviewer on `.cagr/review-evals/*.toml`. `--case` runs one case. `--effort` picks the effort. |
| `help`                                                | Print this list.                                                                                        |

Exit codes: 0 passed, 1 Important findings open, 2 error. With `[review] status = true`, `review` and `answer` also send the `cagr/review` commit status to GitHub. See [Review](review.md).

## risk

```
cagr risk [--base <branch>] [files...]
```

Prints the risk tier of the branch's change compared with `--base` (default: the protected branch, else `main`), the approvals it needs, the reasons, the owners, and the files in each tier. With files, it classifies those files instead. Always exits 0. See [Risk tiers](review.md#risk-tiers).

## ci

```
cagr ci [--base <branch>]
```

Runs the checks the hooks ran on the branch's changed files: generated files, branch name, commit messages, edit checks, turn-end checks, code rules, layout rules, risk, and the pull request body. Exits 1 if any check fails. The base is `--base`, else `GITHUB_BASE_REF`, else the protected branch, else `main`. See [CI](ci.md#cagr-ci).

## check

```
cagr check <files...>
cagr check --all
```

Runs the protected-file check, the `on_edit` commands, the code rules and the layout rules on the named files, outside an agent. Prints the problems and exits 1, or prints "No problems in N files." and exits 0. `on_edit` commands run for real, so formatters may change the files. See [Code rules](code-rules.md#cagr-check-files).

With `--all`, it runs the code rules and layout rules over every file git tracks or would track, and skips the `on_edit` commands. See [Code rules](code-rules.md#cagr-check---all).

## explain

```
cagr explain <id>
```

For a built-in guard: the event it runs on, what it catches, the fix and the config. For a code rule: its message, what to do instead, its note, and its examples. For a layout rule: its message, what to do instead, its note, its files, the name or places it allows, and its example paths. An unknown id lists every known id and exits 1. It works without a config for guards. See [Guards](guards.md).

## rules test

```
cagr rules test
```

Runs every code rule and layout rule against its examples. Prints each failure and a total ("2 rules, 4 examples, 0 failed."). Exits 1 if any example failed. See [Code rules](code-rules.md#cagr-rules-test).

## schema

```
cagr schema
```

Prints the JSON schema for `cagr.toml`. See [JSON schema for editors](configuration.md#json-schema-for-editors).

## hook

```
cagr hook <event> --agent claude|codex
```

Called by the generated agent hook files. Reads the agent's hook JSON on stdin and prints the answer in the agent's format. `<event>` is one of `session.start`, `command.before`, `file.before_edit`, `file.after_edit`, `turn.end`. `--agent` defaults to `claude`. See [Hooks and events](hooks-and-events.md).

You do not run this yourself, but you can pipe a payload into it to see what cagr would do.

## git

```
cagr git commit-msg <message-file>
cagr git pre-push <remote> <url>
```

Called by the generated git hooks. `commit-msg` reads the message file (default `.git/COMMIT_EDITMSG`). `pre-push` reads the refs being pushed on stdin, as git sends them. On failure it prints the problems and "A human can skip this once with CAGR_SKIP=1." and exits 1. If the config is broken, it prints the error and exits 0. See [Git hooks](hooks-and-events.md#git-hooks).

## post-status

```
cagr post-status <sha> --branch <branch> [--checks] [--wait <seconds>]
```

Started in the background by the pre-push hook when `[review] status` is on. It waits up to `--wait` seconds for GitHub to have `<sha>`, sends `cagr/checks` as `success` when `--checks` is given, and sends `cagr/review` from the review record of `<branch>`. It always exits 0 and prints one line per status; the hook sends that output to `.git/cagr/status.log`. See [Commit statuses without a workflow](ci.md#commit-statuses-without-a-workflow).

## Environment variables

| Variable                                                                                         | Used by                                                   | Meaning                                                                       |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `CAGR_SKIP` (or `[git] skip_env`)                                                                | git hooks                                                 | Set to anything but empty or `0` to skip the git hooks once. For humans only. |
| `CAGR_VERSION`, `CAGR_INSTALL_DIR`, `CAGR_REPO`, `CAGR_DOWNLOAD_URL`                             | install script                                            | See [Install](getting-started.md#install).                                    |
| `ANTHROPIC_API_KEY`                                                                              | `review --ci`, nightly scan                               | The key Claude Code uses in CI.                                               |
| `GH_TOKEN`                                                                                       | `review --ci`, `review --scan --issue`, `doctor --github` | The token `gh` uses.                                                          |
| `GITHUB_BASE_REF`, `GITHUB_HEAD_REF`, `GITHUB_EVENT_PATH`, `GITHUB_REPOSITORY`, `GITHUB_ACTIONS` | `ci`, `review --ci`                                       | Set by GitHub Actions.                                                        |
| `XDG_CACHE_HOME`                                                                                 | code rules                                                | Where the Python, Go and Rust parsers are cached.                             |
