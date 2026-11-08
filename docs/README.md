# cagr docs

cagr is a harness for coding agents. One `cagr.toml` sets the guardrails for Claude Code, Codex and, through git hooks, any other agent or human. It denies slips before they happen (the wrong package manager, a push to `main`, an edit to `.env`, `--no-verify`), runs your formatters, linters and code rules after each edit, keeps the agent from finishing while your checks fail, and gates pull requests on a review by a reviewer agent in a fresh context. Every block message says what to do instead, so the agent fixes the slip on its next try.

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
