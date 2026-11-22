---
title: Limits and troubleshooting
nav_order: 12
---

# Limits and troubleshooting

## What cagr is not

cagr is a guard against slips, not a security boundary. It catches the mistakes an agent makes while it tries to do the right thing. An agent that wants to get around it can:

- Hide a command from the command guards with `sh -c "..."`, `eval`, a script file, or a variable.
- Write an ignored file through the shell. The protected-file check uses Git at turn end, so it cannot see new or untracked ignored files such as `.env`. Direct edit tools still check those paths.
- Skip the git hooks once with `CAGR_SKIP=1`, if it is not blocked from setting the variable. That variable is meant for humans.

The turn-end protected-file check covers shell writes in the checkout where the tool runs and in checkouts named by direct edits, literal `cd` or `git -C` targets. cagr cannot attribute an arbitrary script's writes to other checkouts. If Git cannot capture the baseline within the hook budget, cagr lets the tool call through and reports that the snapshot failed. Shell writes also do not trigger after-edit linting. The regular edit-based turn checks still depend on edit tools, and `cagr ci` checks the branch's changes.

cagr keeps temporary copies of protected files that already have unstaged changes so it can tell the agent how to recover them. It removes the copies when the turn passes or reaches the stop limit. A session that ends without a stop hook can leave its copies in cagr's temporary session directory.

The review gate sees `gh` commands only. A pull request opened in the browser or through another client gets past it. Branch protection with the `checks` and `review` jobs as required checks closes that gap. `cagr doctor --github` checks that.

If cagr catches an error, it lets the call through and tells the human why. If the cagr binary is missing or cannot run, `command.before` and `file.before_edit` refuse the call because the repo is configured to use cagr. The other agent hooks warn and let the agent continue. Install cagr or run `cagr doctor` to find the problem. See [Fail-open](hooks-and-events.md#fail-open).

Do not use cagr to hold back an agent you do not trust. Use a sandbox for that.

Other limits:

- Agent hooks exist for Claude Code and Codex. Other agents get only the git hooks and CI.
- v0.1 has one preset, `recommended`. Presets from git URLs are planned for v0.2.
- cagr does not enforce the approval counts of the risk tiers. Branch protection does.

## Lockfiles

The turn-end lockfile check (see [protected-file](guards.md#lockfiles-written-by-the-package-manager)) proves that the package manager, given the lockfile from the start of the turn and the current manifests, writes the lockfile that is in the checkout. Versions and integrity hashes for packages the manifests did not change come from the starting lockfile, so a hand edit to them blocks. New entries come from the manager's own resolution.

It does not prove:

- That the manifests are right. `package.json` stays editable, and a dependency added there by hand is accepted once the lockfile matches it.
- That the registry, the manager's cache or the committed manager config can be trusted. The check runs the manager on `PATH` with the config from the commit at the start of the turn. Config changed during the turn, or left uncommitted before it, is not used, so a lockfile that needs it blocks. Yarn reads rc files from parent folders, so cagr gives Yarn 2 and later a config file name only it knows and runs Yarn 1 with `--no-default-rc`; Yarn 1 then also skips `.npmrc`. pnpm settings in `pnpm-workspace.yaml` still come from the working copy, because that file also lists the workspace packages. pnpm and bun may also find a `pnpm-workspace.yaml` or workspace `package.json` in a parent of the temp folder.
- Anything about an update that changes versions without changing `package.json`, such as `npm update`. That blocks, and the user runs the update instead.

pnpm, npm and Yarn run offline with scripts off, so a package missing from the cache blocks the stop. bun has no offline switch: it reads its manifest cache and may ask the registry for a package missing from it, writing to its own cache. Yarn 1 has no lockfile-only mode, so it links packages into the temp folder, which is slower in a large repo. The check runs in parallel with the turn-end stack checks and stops at the turn-end deadline. Local packages outside the repo, and workspace manifests that Git ignores, are not copied, so a lockfile that needs them blocks.

## Troubleshooting

### The agent hooks do nothing

- Run `cagr doctor`. Under Wiring it shows whether the hook files match the config. If not, run `cagr sync` and commit.
- Under Tools it shows whether `cagr` is on `PATH`. If you installed cagr as a dev dependency, set `[agents] command = "{root}/node_modules/.bin/cagr"` and run `cagr sync`.
- In Codex, approve the project hooks with `/hooks`.
- Check that `agents.enabled` lists your agent.

### "cagr is off for this call because of an error."

cagr hit an error, so it let the call through. The rest of the notice is the error. Most often it is a config problem: run `cagr doctor`, which names the key and suggests the closest known key for a typo. Fix it and the next call is checked again.

### The git hooks do not run

- Run `git config core.hooksPath`. It should print `.githooks` (or your `[git] hooks_path`). If not, run `cagr install-git-hooks`. A fresh clone needs this once.
- If a hook prints "cagr: cagr is not installed, so the pre-push hook did not run.", install cagr. The hook lets the push through until you do.
- `cagr doctor` reports hooks that are not executable.

### A git hook blocks me and I need to get past it once

Set the skip variable for that one command: `CAGR_SKIP=1 git push`. Agents may not do this when `block_hook_skips` is on.

### "Out of date: ... Run `cagr sync`."

The generated files no longer match `cagr.toml`, usually because the config changed and sync was not run, or someone edited a generated file. Run `cagr sync` and commit. A formatter that only changes whitespace in the JSON files does not count as drift.

### My PR template or CODEOWNERS keeps being rewritten

`cagr sync` owns these files while they carry the "Generated by `cagr sync`" mark. Remove the mark and sync leaves them alone.

### The agent was let go while checks still fail

After 3 failing stops in a turn, cagr lets the agent stop and tells you: "cagr: ... still failing after 3 attempts. The agent was let go so it does not loop. Run the checks yourself before you merge." Run the named check, fix it or ask the agent to, and let `cagr ci` hold the merge.

### Hooks are slow

Run `cagr doctor`. Under Timing it shows the median and max of each hook and each command against the [budgets](hooks-and-events.md#time-budgets). To speed up:

- Pass `{files}` to `on_edit` commands so they check only the changed files.
- Move slow checks from `on_edit` to `on_turn_end`, and from `on_turn_end` to `git.pre_push` or CI.
- Narrow each stack's `paths` so a change in one area does not run another area's checks.

### `gh pr create` is denied though I ran `cagr review`

The gate checks the current commit. If you committed after the review, run `cagr review` again: it reviews only the new commits. `cagr review status` shows the last reviewed commit and what is still open. If you open the pull request for another branch with `--head`, or run `gh pr ready <branch>`, the gate checks that branch. If the same line runs anything but `git add`, `git push`, `git status`, `git diff` or `git log` before `gh pr create`, the gate denies it: run that first, then `gh pr create` on its own. One literal `cd <path> &&` at the start is fine, and the gate then checks the repo in that folder.

### The review fails with "Commit your changes first."

The review covers commits, so tracked changes must be committed first. Untracked files do not count.

### The reviewer could not run

`cagr review` exits 2 and prints the error. Check that `claude` or `codex` is installed and signed in, or set `[review] reviewer`. If the reviewer times out, raise `[review] timeout_seconds`. Until it runs, the gate lets the pull request through and tells the human it went out unreviewed, unless earlier findings are still open.

### The reviewer flags things that are not problems

Answer them with `cagr review answer <id> --wrong "<why>"`. `cagr review stats` shows how often that happens. Tell the reviewer what to skip in the review guide (`.cagr/review.md`), then run `cagr review eval` to check it did not miss more bugs.

### Code rules do not fire

- Run `cagr rules test`. If an invalid example does not fire, fix the `rule`.
- Check the `language`: a `typescript` rule does not check `.js` files. Use `language: [typescript, javascript]` to check both.
- Check `files` and `ignores`.
- Run `cagr check <file>` on a file that should match.

### `cagr ci` fails on "Edit checks" with changed files

Your `on_edit` commands changed files in CI, so the branch was committed without being formatted or fixed. Run `cagr check <files>` locally, commit the changes, and push.

### npm says `cagr-<os>-<arch> is not installed`

The platform package was skipped, usually because of `--no-optional`. Reinstall without it, or use the install script.

### On Alpine, cagr does not start

Install the C++ runtime: `apk add libstdc++ libgcc`.

Lint suppression checks cover added lines in supported languages, not every way
to weaken a tool. The recommended preset protects dedicated lint configs, but
leaves `pyproject.toml`, `package.json` and `tsconfig.json` editable because agents
need them for other work. Lint rules and type checking can still be weakened in
those files. Review their changes. Suppressions already present at HEAD (or at
the branch base in CI) are not audited. See `docs/guards.md` for lexical limits.
