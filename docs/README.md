---
title: Home
nav_order: 1
permalink: /
---

# cagr

cagr is a harness for coding agents. One `cagr.toml` sets the guardrails for Claude Code, Codex and, through git hooks, any other agent or human. It denies slips before they happen (the wrong package manager, a push to `main`, an edit to `.env`, `--no-verify`), runs your formatters, linters and code rules after each edit, keeps the agent from finishing while your checks fail, and gates pull requests on a review by a reviewer agent in a fresh context. Every block message says what to do instead, so the agent fixes the slip on its next try.

## Quick start

```sh
# Install the binary (macOS, Linux)
curl -fsSL https://github.com/krtinshet/cagr/releases/latest/download/install.sh | sh
# or add it to a JavaScript repo
bun add -d cagr        # or: npm i -D cagr

# Set up a repo
cd your-repo
cagr init              # detects your stacks, writes cagr.toml and the hook files
cagr doctor            # checks the wiring, the tools, and how long each hook takes
```

Commit `cagr.toml`, `.claude/settings.json`, `.codex/hooks.json` and `.githooks/`. Codex asks you to trust project hooks once: open Codex in the repo and approve them with `/hooks`. The [getting started](getting-started.md) page has the details.

## A first config

```toml
extends = ["recommended"]

[git]
protected_branch = "main"

[[stack]]
language = "typescript"
package_manager = "bun"
paths = ["**"]
on_edit = ["biome check --write {files}"]
on_turn_end = ["bun run lint", "bunx tsc --noEmit"]

[[commands.blocked]]
match = "prisma db push"
reason = "Use `bun run db:migrate --name <change>`."
```

After you change the config, run `cagr sync` to rewrite the hook files. Every key is in [configuration](configuration.md).

## Pages

- [Getting started](getting-started.md): install, `cagr init`, `cagr doctor`, the files to commit, and the Codex trust step.
- [Configuration](configuration.md): every key in `cagr.toml`, presets and `extends`, placeholders, `cagr sync`, and the JSON schema.
- [Guards](guards.md): every built-in guard, what it blocks, its message, and how to configure or turn it off.
- [Hooks and events](hooks-and-events.md): the five events, how Claude Code and Codex map onto them, time budgets, fail-open, and the git hooks.
- [Code rules](code-rules.md): ast-grep rules in `.cagr/rules/*.yml`, `cagr rules test`, `cagr check` and `cagr explain`.
- [Review](review.md): `cagr review`, effort levels, findings, rounds, answers, stats, evals, the PR gate, `REVIEW.md` and risk tiers.
- [CI](ci.md): `cagr ci`, `cagr review --ci`, the generated workflow, PR template and CODEOWNERS, and `cagr doctor --github`.
- [CLI reference](cli.md): every command and flag.
- [Limits and troubleshooting](limits.md): what cagr is not, and what to do when something goes wrong.

Source on [GitHub](https://github.com/krtinshet/cagr). Package on [npm](https://www.npmjs.com/package/cagr). MIT license.
