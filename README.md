# guardwright

One config for every coding agent's guardrails, in every language.

Coding agents slip. They run `npm install` in a bun repo, push to `main`, edit `.env`, skip hooks with `--no-verify`, and stop while the type check is still red. guardwright watches what the agent does and stops each slip at the earliest moment it can see it. Every block message says what to do instead, so the agent fixes it on the next try.

- **Commands**: it denies the wrong package manager, a push to the protected branch, a force push, hook skips, and any command you list, before the command runs.
- **Files**: it denies edits to protected files such as `.env*` and lockfiles, before the edit happens.
- **Edits**: after each edit it runs your formatters and linters (Biome, ESLint, Ruff) and your own ast-grep code rules, on the changed files only.
- **End of turn**: the agent may not finish while your checks (tsc, mypy, pytest, `bun run lint`) fail. After 3 blocked stops it lets the agent go and tells the human, so it never traps the agent in a loop.
- **Git**: the commit-msg and pre-push hooks check commit subjects, branch names and pushes to `main`. They cover any agent, and any human, even without agent hooks.

guardwright does not replace your tools. It runs them at the right moment and shows the agent only what matters: findings in the files it changed, deduped and cut short.

It works with Claude Code and Codex today, and through the git hooks with every other agent.

## Quick start

```sh
curl -fsSL https://github.com/guardwright/guardwright/releases/latest/download/install.sh | sh
# or: bun add -d guardwright    /    uv tool install guardwright

cd your-repo
guardwright init      # detects your stacks, writes guardwright.toml and the hook files
guardwright doctor    # checks the wiring, the tools, and how long each hook takes
```

`init` writes `guardwright.toml`, `.claude/settings.json`, `.codex/hooks.json` and `.githooks/`, then sets `core.hooksPath`. Commit all of them. Codex asks you to trust project hooks once: open Codex in the repo and approve them with `/hooks`.

## Config

`guardwright.toml`, or `[tool.guardwright]` in `pyproject.toml`:

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
- After you change the config, run `guardwright sync` to rewrite the hook files. `guardwright sync --check` fails in CI when they drift.
- `schema/guardwright.schema.json` is the JSON schema, for editor completion.

## Code rules

Put ast-grep rules in `.guardwright/rules/*.yml`. Each rule must say what to use instead and carry examples, so it can be tested:

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

`guardwright rules test` fails when an invalid example does not fire or a valid one does. Languages: TypeScript, TSX, JavaScript, Python, Go, Rust, HTML, CSS. Biome `.grit` rules stay in Biome.

## Commands

| Command                       | What it does                                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| `init [--dry-run] [--force]`  | Detect the repo, write the config, the agent hooks and the git hooks.                  |
| `sync [--check]`              | Rewrite the generated files, or fail when they drift.                                  |
| `install-git-hooks`           | Write the git hooks and set `core.hooksPath`.                                          |
| `doctor`                      | Check the config, the wiring, the tools on PATH, and hook timings against the budgets. |
| `check <files...>`            | Run the edit checks and code rules on files, outside an agent.                         |
| `explain <id>`                | Explain a built-in guard or a code rule.                                               |
| `rules test`                  | Test every rule's examples.                                                            |
| `hook <event> --agent <name>` | Called by the agent hooks.                                                             |
| `git <hook>`                  | Called by the git hooks.                                                               |

## Time budgets

A guard that slows the agent down gets turned off, so guardwright keeps to budgets: under 50ms before a command or edit, under 1s after an edit (changed files only), under 60s at the end of a turn. `guardwright doctor` shows the measured times.

## What it is not

guardwright is a guard against slips, not a security boundary. An agent that wants to get around it can: `sh -c "..."`, `eval`, a script file, or a variable can hide a command; edits made through the shell (`sed -i`, `cat >`) are not seen as edits; a human can skip the git hooks once with `GUARDWRIGHT_SKIP=1`. If guardwright itself fails, it lets the call through and says why, so a bug in guardwright never stops your agent.

Do not use it to hold back an agent you do not trust. Use a sandbox for that.

## Notes

- On Alpine and other musl systems, install `libstdc++` and `libgcc` first (`apk add libstdc++ libgcc`).
- When the `guardwright` binary is not installed, the git hooks print a warning and let the commit or push through, so a teammate without it is not stuck.

See [ROADMAP.md](ROADMAP.md) for what v0.1 leaves out.
