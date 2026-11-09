---
title: Configuration
nav_order: 3
---

# Configuration

cagr reads its config from `cagr.toml`, or from a `[tool.cagr]` table in `pyproject.toml`. It looks in the current folder, then in each parent folder, and uses the first one it finds. In each folder, `cagr.toml` wins over `pyproject.toml`. The folder that holds the config is the repo root for cagr: globs and `{files}` paths are relative to it.

A full example:

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

The same config in `pyproject.toml` puts every table under `tool.cagr`, for example `[tool.cagr.git]` and `[[tool.cagr.stack]]`.

When the config has an error, cagr names the key and, for a misspelled key, suggests the closest known one ("Did you mean ...?").

After you change the config, run `cagr sync` to rewrite the generated files. See [Generated files](#generated-files-and-cagr-sync).

## Presets

`extends` lists presets the config builds on. v0.1 has one preset, `"recommended"`. Presets from git URLs are planned for v0.2. Any other name is an error.

How a preset merges with your config:

- Tables merge key by key, at every depth.
- Lists of tables (`[[stack]]`, `files.protected`, `commands.blocked`, `risk.paths`) add your entries to the preset's.
- Any other value, including a plain list, replaces the preset's.

So you cannot remove a preset's protected file by leaving it out. To change what `recommended` does, set the single values you want to differ, such as `block_force_push = false`.

### What `recommended` sets

| Key                       | Value                                                                                                                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git.protected_branch`    | `"main"`                                                                                                                                                                                                                           |
| `git.branch_name`         | `"type/name"`                                                                                                                                                                                                                      |
| `git.commit_message`      | `"conventional"`                                                                                                                                                                                                                   |
| `git.block_force_push`    | `true`                                                                                                                                                                                                                             |
| `git.block_hook_skips`    | `true`                                                                                                                                                                                                                             |
| `review.enabled`          | `true`                                                                                                                                                                                                                             |
| `review.pr_sections`      | `["Testing", "Risk", "How to revert"]`                                                                                                                                                                                             |
| `review.agents_may_merge` | `false`                                                                                                                                                                                                                            |
| `risk.paths`              | `.github/workflows/**` is `high` ("CI workflows run with the repo's secrets."). `{**/*.md,docs/**}` is `low` ("Docs and copy.").                                                                                                   |
| `files.protected`         | `.env*`, except `.env.example`, `.env.sample` and `.env.template`. The lockfiles `bun.lock`, `bun.lockb`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `uv.lock`, `poetry.lock`, `Pipfile.lock`, `Cargo.lock` and `go.sum`. |

The reasons shown for the protected files:

- `.env*`: "Env files hold real values. Do not edit them; tell the user which key is missing."
- Lockfiles: "Lockfiles are written by the package manager. Change dependencies with its add or remove command instead."

## Top-level keys

| Key       | Type            | Default | Meaning                                                       |
| --------- | --------------- | ------- | ------------------------------------------------------------- |
| `$schema` | string          | none    | Path or URL of the JSON schema, for editors. cagr ignores it. |
| `extends` | list of strings | `[]`    | Presets this config builds on. See [Presets](#presets).       |
| `brief`   | list of strings | `[]`    | Extra lines for the brief the agent gets at session start.    |

## `[agents]`

| Key       | Type                          | Default               | Meaning                                                                                |
| --------- | ----------------------------- | --------------------- | -------------------------------------------------------------------------------------- |
| `enabled` | list of `"claude"`, `"codex"` | `["claude", "codex"]` | Agents whose hook files `cagr sync` writes.                                            |
| `command` | string                        | `"cagr"`              | How the generated hook files call cagr. `{root}` becomes the repo root for each agent. |
| `nested_docs` | boolean                   | `false`               | Write a `CLAUDE.md` that imports `AGENTS.md` next to every `AGENTS.md` that has none. See below. |

`{root}` becomes `"$CLAUDE_PROJECT_DIR"` in the Claude Code hooks and `"$(git rev-parse --show-toplevel)"` in the Codex hooks and the git hooks. Use it when cagr is not on `PATH`, for example `command = "{root}/node_modules/.bin/cagr"`.

### Nested `AGENTS.md` files

Codex reads `AGENTS.md` and Claude Code reads `CLAUDE.md`. A monorepo often keeps an `AGENTS.md` in each app or package. With `nested_docs = true`, `cagr sync` writes a `CLAUDE.md` beside every `AGENTS.md` that git tracks (or would track) and that has no `CLAUDE.md`:

```markdown
<!-- Generated by `cagr sync`: Claude Code reads CLAUDE.md, so this imports AGENTS.md. Edit AGENTS.md instead. -->
@AGENTS.md
```

A `CLAUDE.md` you wrote stays as it is, and so does a shim once you add a line to it or replace it with a symlink. The option needs git to find the `AGENTS.md` files; if `git ls-files` fails, sync says so and stops. Sync deletes a `CLAUDE.md` it wrote when the `AGENTS.md` beside it is gone, or when you turn `nested_docs` off. `cagr sync --check`, `cagr doctor` and `cagr ci` report a missing or leftover one as out of date.

## `[git]`

| Key                | Type                                  | Default                                                                             | Meaning                                                                             |
| ------------------ | ------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `protected_branch` | string                                | none                                                                                | The branch agents may not push to. An empty string turns the check off.             |
| `branch_name`      | `"type/name"`, `"off"`, or a table    | off                                                                                 | Branch name rule, checked on push.                                                  |
| `commit_message`   | `"conventional"`, `"off"`, or a table | off                                                                                 | Commit subject rule, checked by the commit-msg hook.                                |
| `commit_types`     | list of strings                       | `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore`, `ci`, `build`, `revert` | Types allowed in branch names and commit subjects.                                  |
| `pre_push`         | string or list of strings             | `[]`                                                                                | Commands the pre-push hook runs. A failure stops the push.                          |
| `block_force_push` | boolean                               | `false`                                                                             | Block force pushes.                                                                 |
| `block_hook_skips` | boolean                               | `false`                                                                             | Block `--no-verify`, changing `core.hooksPath`, and setting the skip variable.      |
| `skip_env`         | string                                | `"CAGR_SKIP"`                                                                       | The environment variable a human sets to skip the git hooks. Agents may not set it. |
| `hooks_path`       | string                                | `".githooks"`                                                                       | Folder for the git hooks, set as `core.hooksPath`.                                  |
| `worktree_only`    | boolean                               | `false`                                                                             | Keep the main checkout clean: agents edit and commit only in worktrees.             |
| `worktree_dir`     | string                                | `".worktrees"`                                                                      | Folder inside the main checkout where worktrees live.                               |

### Name rules

`branch_name` takes `"type/name"` and `commit_message` takes `"conventional"`. Both also take `"off"` or your own rule.

| Value            | Pattern                                                                                                                                                                    | Example                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `"type/name"`    | `<type>/<short-kebab-name>`: a type from `commit_types`, a slash, then lowercase words joined by dashes.                                                                   | `feat/deal-pipeline`              |
| `"conventional"` | `<type>(<scope>): <summary>`: a type, an optional scope in parentheses, an optional `!`, a colon, then a lowercase summary with no trailing period. At most 72 characters. | `feat(deals): add pipeline board` |
| `"off"`          | No check.                                                                                                                                                                  |                                   |

Your own rule is a table with both a `pattern` (a regular expression) and an `example` (a valid value, shown in the block message):

```toml
[git.branch_name]
pattern = "^[a-z]+/[A-Z]+-[0-9]+$"
example = "feat/ENG-123"
```

An invalid regular expression is a config error.

Some subjects are never checked: those that start with `Merge `, `Revert `, `fixup! ` or `squash! `. The branch rule is not checked for a detached `HEAD` or for the protected branch.

## `[[stack]]`

One entry per language area of the repo. `language` is required.

| Key               | Type                                                                 | Default     | Meaning                                                                                                       |
| ----------------- | -------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------- |
| `language`        | string                                                               | required    | `typescript`, `javascript`, `python`, `go`, `rust`, or any name.                                              |
| `package_manager` | one of `bun`, `npm`, `pnpm`, `yarn`, `uv`, `pip`, `poetry`, `pipenv` | none        | The only package manager agents may use for this ecosystem. See [package-manager](guards.md#package-manager). |
| `paths`           | list of globs                                                        | `["**"]`    | Globs, relative to the repo root, this stack covers.                                                          |
| `extensions`      | list of strings                                                      | by language | File extensions this stack checks, without the dot.                                                           |
| `on_edit`         | list of strings                                                      | `[]`        | Commands run after each edit, on the changed files only.                                                      |
| `on_turn_end`     | list of strings                                                      | `[]`        | Commands run before the agent may end a turn that changed files in this stack.                                |

Default extensions:

| Language       | Extensions                                     |
| -------------- | ---------------------------------------------- |
| `typescript`   | `ts tsx mts cts js jsx mjs cjs json jsonc css` |
| `javascript`   | `js jsx mjs cjs json jsonc css`                |
| `python`       | `py pyi`                                       |
| `go`           | `go`                                           |
| `rust`         | `rs`                                           |
| any other name | none, so every file under `paths` counts       |

A file belongs to a stack when it matches one of its `paths` and has one of its `extensions`.

### `{files}`

In `on_edit` and `on_turn_end` commands, `{files}` becomes the changed files that belong to the stack, as repo-relative paths, each quoted for the shell and separated by spaces.

- A command with `{files}` is skipped when no files match.
- An `on_turn_end` command without `{files}` runs once for the whole repo.

See [Hooks and events](hooks-and-events.md) for when each list runs and how long it may take.

## `[files]`

| Key                  | Type           | Default             | Meaning                                                    |
| -------------------- | -------------- | ------------------- | ---------------------------------------------------------- |
| `protected`          | list of tables | `[]`                | Files agents may not edit.                                 |
| `protected[].glob`   | string         | required            | A glob. Without a slash it matches the file name anywhere. |
| `protected[].except` | list of globs  | `[]`                | Globs that stay editable.                                  |
| `protected[].reason` | string         | required, not empty | What to do instead. Shown to the agent.                    |

## `[commands]`

| Key                | Type           | Default             | Meaning                                                                                               |
| ------------------ | -------------- | ------------------- | ----------------------------------------------------------------------------------------------------- |
| `blocked`          | list of tables | `[]`                | Commands agents may not run.                                                                          |
| `blocked[].match`  | string         | required, not empty | Words that, in order, inside one command, block it. Text in quotes and heredoc bodies does not count. |
| `blocked[].reason` | string         | required, not empty | What to run instead. Shown to the agent.                                                              |

See [blocked-command](guards.md#blocked-command) for how matching works.

## `[rules]`

| Key    | Type            | Default           | Meaning                                        |
| ------ | --------------- | ----------------- | ---------------------------------------------- |
| `dirs` | list of strings | `[".cagr/rules"]` | Folders holding rule files (`*.yml`). |

The rules themselves, code rules and [layout rules](code-rules.md#layout-rules), are YAML files in these folders, not keys in `cagr.toml`. See [Code rules](code-rules.md).

## `[review]`

| Key                | Type                              | Default                           | Meaning                                                                                                                            |
| ------------------ | --------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`          | boolean                           | `false`                           | Gate pull requests on a review by a reviewer agent in a fresh context.                                                             |
| `gate`             | list of strings                   | `["gh pr create", "gh pr ready"]` | Commands that need a passing review of the current commit, matched like `commands.blocked`.                                        |
| `reviewer`         | string                            | `"auto"`                          | `"auto"`, `"claude"`, `"codex"`, or a command. A command gets `{prompt_file}` and `{schema_file}` and prints the findings as JSON. |
| `model`            | string                            | none                              | Model for the reviewer agent, if not its default.                                                                                  |
| `guide`            | string                            | `"REVIEW.md"`                     | The repo's review instructions, read into every review. A missing file is fine.                                                    |
| `effort`           | `"quick"`, `"standard"`, `"deep"` | `"standard"`                      | How many agents review. See [Effort](review.md#effort).                                                                            |
| `security`         | boolean                           | `true`                            | Run a security finder in standard and deep reviews.                                                                                |
| `max_rounds`       | integer, at least 1               | `3`                               | After this many rounds the gate asks the author to step back and rethink the approach.                                             |
| `timeout_seconds`  | integer, at least 30              | `600`                             | How long one reviewer agent may run.                                                                                               |
| `skip`             | list of globs                     | `[]`                              | Files the reviewer does not review.                                                                                                |
| `pr_sections`      | list of strings                   | `[]`                              | Headings a pull request body must have. `gh pr create` without them is denied.                                                     |
| `agents_may_merge` | boolean                           | `true`                            | Let agents run `gh pr merge` and `gh pr review --approve`. When `false`, approval stays with a person.                             |

See [Review](review.md).

## `[risk]`

| Key              | Type                          | Default    | Meaning                                                                                                  |
| ---------------- | ----------------------------- | ---------- | -------------------------------------------------------------------------------------------------------- |
| `default`        | `"low"`, `"medium"`, `"high"` | `"medium"` | Tier of a file that no `risk.paths` entry matches.                                                       |
| `paths`          | list of tables                | `[]`       | A file takes the highest tier of the entries it matches. The change takes the highest tier of its files. |
| `paths[].glob`   | string                        | required   | Files this entry covers.                                                                                 |
| `paths[].tier`   | `"low"`, `"medium"`, `"high"` | required   | Their risk tier.                                                                                         |
| `paths[].owners` | list of strings               | `[]`       | Code owners for these files (`@user` or `@org/team`), written to CODEOWNERS.                             |
| `paths[].reason` | string                        | none       | Why these files carry this tier.                                                                         |

A low change needs no human approval, a medium one needs one, and a high one needs two. See [Risk tiers](review.md#risk-tiers).

## `[ci]`

| Key       | Type          | Default                                                                                  | Meaning                                                                                               |
| --------- | ------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `github`  | boolean       | `false`                                                                                  | `cagr sync` writes the GitHub workflow, the pull request template and CODEOWNERS.                     |
| `review`  | boolean       | `false`                                                                                  | The workflow reviews each pull request with `cagr review --ci`. Needs the `ANTHROPIC_API_KEY` secret. |
| `nightly` | list of globs | `[]`                                                                                     | Globs the workflow reviews every night with `cagr review --scan`, opening an issue for findings.      |
| `install` | string        | `curl -fsSL https://github.com/krtinshet/cagr/releases/latest/download/install.sh \| sh` | The shell command the workflow uses to install cagr.                                                  |

See [CI](ci.md).

## Globs

Globs work like `.gitignore` patterns:

- A pattern with no slash matches the file name at any depth. `.env*` matches `.env` and `apps/web/.env.local`.
- A pattern with a slash matches from the repo root. `src/auth/**` matches only under the root's `src/auth`.
- A leading `/` is dropped, so `/src/**` is the same as `src/**`.
- Braces list choices: `{**/*.md,docs/**}`.

## Generated files and `cagr sync`

`cagr sync` writes these files from the config:

- `.claude/settings.json` (when `claude` is in `agents.enabled`).
- `.codex/hooks.json` (when `codex` is in `agents.enabled`).
- `<hooks_path>/commit-msg` and `<hooks_path>/pre-push`.
- With `agents.nested_docs = true`: a `CLAUDE.md` beside each `AGENTS.md` that has none. See [Nested `AGENTS.md` files](#nested-agentsmd-files).
- With `ci.github = true`: `.github/workflows/cagr.yml`, `.github/pull_request_template.md` (when `review.pr_sections` is set) and `.github/CODEOWNERS` (when some `risk.paths` entry has owners). See [CI](ci.md).

Things to know:

- In the agent hook files, sync manages only cagr's own entries. Hooks you added stay.
- The PR template and CODEOWNERS belong to you once you edit them. Sync writes them only while they still carry the "Generated by `cagr sync`" mark. If the mark is gone, sync keeps your file and prints a note. If you keep your own CODEOWNERS or PR template in another place GitHub reads (the root, `docs/`, or a `PULL_REQUEST_TEMPLATE/` folder), sync does not write its own. See [CI](ci.md).
- JSON files are compared as data, so a formatter that changes whitespace does not count as a change.

`cagr sync --check` writes nothing. It lists the files that are out of date ("Out of date: ... Run `cagr sync`.") and exits 1, so CI can fail on drift. `cagr ci` runs this check too.

## JSON schema for editors

`cagr schema` prints the JSON schema for `cagr.toml`. The repo also keeps a copy at `schema/cagr.schema.json`. To get completion and checks in an editor that reads `$schema` (for example with the Even Better TOML extension or Taplo), save the schema in your repo and point to it:

```sh
cagr schema > cagr.schema.json
```

```toml
"$schema" = "./cagr.schema.json"
extends = ["recommended"]
```
