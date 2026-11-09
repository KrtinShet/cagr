# cagr

One config for every coding agent's guardrails, in every language.

Coding agents slip. They run `npm install` in a bun repo, push to `main`, edit `.env`, skip hooks with `--no-verify`, and stop while the type check is still red. cagr watches what the agent does and stops each slip at the earliest moment it can see it. Every block message says what to do instead, so the agent fixes it on the next try.

- **Commands**: it denies the wrong package manager, a push to the protected branch, a force push, hook skips, and any command you list, before the command runs.
- **Files**: it denies edits to protected files such as `.env*` and lockfiles, before the edit happens.
- **Edits**: after each edit it runs your formatters and linters (Biome, ESLint, Ruff) and your own ast-grep code rules, on the changed files only. Layout rules stop a new file from being created with the wrong name or in the wrong folder.
- **End of turn**: the agent may not finish while your checks (tsc, mypy, pytest, `bun run lint`) fail. It blocks at most 2 stops in a row, then lets the agent go and tells the human, so it never traps the agent in a loop.
- **Pull requests**: `gh pr create` is denied until a reviewer agent in a fresh context has reviewed the current commit and every Important finding is fixed or answered. Agents may not merge or approve. See [Review](#review).
- **Git**: the commit-msg and pre-push hooks check commit subjects, branch names and pushes to `main`. They cover any agent, and any human, even without agent hooks.

cagr does not replace your tools. It runs them at the right moment and shows the agent only what matters: findings in the files it changed, deduped and cut short.

It works with Claude Code and Codex today, and through the git hooks with every other agent.

## Docs

The full docs are at [krtinshet.github.io/cagr](https://krtinshet.github.io/cagr/), and in [docs/](docs/README.md):

- [Getting started](docs/getting-started.md): install, `cagr init`, `cagr doctor`.
- [Configuration](docs/configuration.md): every key in `cagr.toml`.
- [Guards](docs/guards.md): every built-in guard and its message.
- [Hooks and events](docs/hooks-and-events.md), [Code rules](docs/code-rules.md), [Review](docs/review.md), [CI](docs/ci.md).
- [CLI reference](docs/cli.md), [Limits and troubleshooting](docs/limits.md) and [Releasing](docs/releasing.md).

## Quick start

```sh
curl -fsSL https://github.com/krtinshet/cagr/releases/latest/download/install.sh | sh
# or: bun add -d @krtinshet/cagr    /    npm i -D @krtinshet/cagr

cd your-repo
cagr init      # detects your stacks, writes cagr.toml and the hook files
cagr doctor    # checks the wiring, the tools, and how long each hook takes
```

`init` writes `cagr.toml`, `.claude/settings.json`, `.codex/hooks.json` and `.githooks/`, then sets `core.hooksPath`. Commit all of them. Codex asks you to trust project hooks once: open Codex in the repo and approve them with `/hooks`.

## Config

`cagr.toml`, or `[tool.cagr]` in `pyproject.toml`:

```toml
extends = ["recommended"]
[git]
protected_branch = "main"
branch_name = "type/name"
commit_message = "conventional"
pre_push = "bun run verify"
[[stack]]
language = "typescript"
package_manager = "bun"
paths = ["**"]
on_edit = ["biome check --write {files}"]
on_turn_end = ["bun run lint", "bunx tsc --noEmit"]
[[stack]]
language = "python"
package_manager = "uv"
paths = ["services/ml/**"]
on_edit = ["ruff check --fix {files}", "ruff format {files}"]
on_turn_end = ["pytest -q services/ml"]
[files]
protected = [{ glob = ".env*", except = [".env.example"], reason = "Tell the user which key is missing." }]
[commands]
blocked = [{ match = "prisma db push", reason = "Use `bun run db:migrate --name <change>`." }]
```

- `recommended` turns on the git rules, blocks force pushes and hook skips, and protects `.env*` and lockfiles. Lists of tables (`stack`, `files.protected`, `commands.blocked`) add to the preset's. Other values replace them.
- `{files}` becomes the changed files that match the stack's `paths`. A turn-end command without `{files}` runs once for the whole repo.
- After you change the config, run `cagr sync` to rewrite the hook files. `cagr sync --check` fails in CI when they drift.
- `schema/cagr.schema.json` is the JSON schema, for editor completion.

## Code rules

Put ast-grep rules in `.cagr/rules/*.yml`. Each rule must say what to use instead and carry examples, so it can be tested:

```yaml
id: no-console-log
language: typescript
message: console.log($$$ARGS) leaves debug output in app code.
instead: Use `logger.info` from src/lib/logger.ts.
ignores: ["scripts/**"]
rule:
  pattern: console.log($$$ARGS)
examples:
  invalid: ['console.log("hi")']
  valid: ['logger.info("hi")']
```

Layout rules go in the same folder. A `layout:` block in place of `rule:` checks file names and folders, with example paths:

```yaml
id: kebab-files
message: Files use kebab-case names.
instead: Rename it, such as user-card.ts.
layout:
  files: ["src/**/*.ts"]
  name: "^[a-z0-9]+(-[a-z0-9]+)*$"
examples:
  invalid: [src/UserCard.ts]
  valid: [src/user-card.ts]
```

`cagr rules test` fails when an invalid example does not fire or a valid one does. Languages: TypeScript, TSX, JavaScript, Python, Go, Rust, HTML, CSS. Biome `.grit` rules stay in Biome.

## Review

`cagr review` reviews the branch against its base with a reviewer agent: Claude Code or Codex, whichever you run, started read-only in a fresh context. It reads `REVIEW.md` (what matters in this repo), the diff, the commit messages and the risk tier, and reads any other file it needs.

- **Effort** sets the agents. `quick`: one bug finder. `standard`: a bug finder and a security finder, then a verifier that drops what it cannot confirm. `deep`: three finders and three verifiers, keeping a finding when two agree. A high-risk change gets `deep` unless you pass `--effort`.
- **Findings** are Important, Nit or Pre-existing. Style findings are dropped. Only Important ones hold the gate.
- **Rounds**: after round 1 the reviewer sees only the new commits and the open findings, marks what was fixed, and does not repeat itself. After `max_rounds` (3) it tells the author to step back.
- **Answers**: a finding that is wrong or intentional gets an answer instead of a fix: `cagr review answer f2 --wrong "the list is never empty here"`. A person reads every answer. `review stats` shows rounds to pass and how often findings were answered as wrong, which is the reviewer's noise.
- **Evals**: put past bugs in `.cagr/review-evals/*.toml` (a commit range and where the bug was, or `clean = true`). `review eval` scores the reviewer and compares with the last run, so a change to `REVIEW.md` or the model can be measured.
- **Fails open**: when the reviewer cannot run, the round is recorded as an error, and the gate lets the PR through and tells the human it went out unreviewed.

```toml
[review]
effort = "standard"
skip = ["**/*.snap"]
pr_sections = ["Testing", "Risk", "How to revert"]   # gh pr create needs these headings
# reviewer = "auto"       # or "claude", "codex", or a command that prints the findings as JSON

[[risk.paths]]
glob = "src/auth/**"
tier = "high"             # low: no approval, medium: one, high: two
owners = ["@org/security"]
reason = "Sign-in and sessions."

[ci]
github = true             # sync writes the workflow, the PR template and CODEOWNERS
review = true             # the workflow reviews each PR; needs the ANTHROPIC_API_KEY secret
nightly = ["src/**"]      # reviews old code every night and opens an issue
```

In CI, `cagr ci` runs the checks the agent ran (edit checks, turn-end checks, code rules, commit and branch names, generated files, the PR body) on the branch's changed files, so a change made without the hooks cannot merge. `cagr review --ci` posts the review as inline PR comments; resolving a thread counts as an answer. `cagr doctor --github` checks the branch protection that only GitHub can enforce: approvals, stale approval dismissal, thread resolution, code owners, required checks.

## Commands

| Command                           | What it does                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `init [--dry-run] [--force]`      | Detect the repo, write the config, the agent hooks and the git hooks.                                               |
| `sync [--check]`                  | Rewrite the generated files, or fail when they drift.                                                               |
| `install-git-hooks`               | Write the git hooks and set `core.hooksPath`.                                                                       |
| `doctor [--github]`               | Check the config, the wiring, the tools on PATH, and hook timings against the budgets.                              |
| `review [...]`                    | Review the branch with a reviewer agent. `review help` lists `answer`, `status`, `stats`, `eval`, `--scan`, `--ci`. |
| `risk [--base <b>]`               | The change's risk tier, the approvals it needs, and the owners.                                                     |
| `ci [--base <b>]`                 | In CI: the checks the hooks ran, on the branch's changed files.                                                     |
| `check <files...>`, `check --all` | Run the edit checks and code rules on files, or the code and layout rules on every file.                            |
| `explain <id>`                    | Explain a built-in guard, a code rule or a layout rule.                                                             |
| `rules test`                      | Test every rule's examples.                                                                                         |
| `hook <event> --agent <name>`     | Called by the agent hooks.                                                                                          |
| `git <hook>`                      | Called by the git hooks.                                                                                            |

## Time budgets

A guard that slows the agent down gets turned off, so cagr keeps to budgets: under 50ms before a command or edit, under 1s after an edit (changed files only), under 60s at the end of a turn. `cagr doctor` shows the measured times.

## What it is not

cagr is a guard against slips, not a security boundary. An agent that wants to get around it can: `sh -c "..."`, `eval`, a script file, or a variable can hide a command; edits made through the shell (`sed -i`, `cat >`) are not seen as edits; a human can skip the git hooks once with `CAGR_SKIP=1`. The review gate sees `gh` commands only, not a pull request opened through the web or another client; branch protection and the CI review job close that gap. If cagr itself fails, it lets the call through and says why, so a bug in cagr never stops your agent.

Do not use it to hold back an agent you do not trust. Use a sandbox for that.

## Notes

- On Alpine and other musl systems, install `libstdc++` and `libgcc` first (`apk add libstdc++ libgcc`).
- When the `cagr` binary is not installed, the git hooks print a warning and let the commit or push through, so a teammate without it is not stuck.

## License

MIT. See [LICENSE](LICENSE).
