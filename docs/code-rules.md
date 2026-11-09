---
title: Code rules
nav_order: 6
---

# Code rules

Your repo's own rules live in YAML files next to each other, in two kinds:

- **Code rules** catch patterns in your code that a linter does not know about, like a `console.log` in app code or a raw SQL call outside the data layer. They are [ast-grep](https://ast-grep.github.io/) rules, so they match the syntax tree, not text.
- **[Layout rules](#layout-rules)** say what a file may be called and where it may live. They look at the path only.

cagr runs both after each edit and at the end of each turn, on the changed files only, and again in CI. Layout rules also run before a new file is created.

Biome `.grit` rules stay in Biome. Run Biome from `on_edit`.

## Where rules live

Put rule files in `.cagr/rules/`. cagr reads every `*.yml` and `*.yaml` file in that folder and its subfolders. To use other folders, set `[rules] dirs`:

```toml
[rules]
dirs = [".cagr/rules", "tools/rules"]
```

A file can hold one rule, or several separated by `---`, and can mix both kinds. A rule with a top-level `layout:` block is a layout rule; any other is a code rule. Rules are not set in `cagr.toml`, which only wires cagr up.

## A code rule

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

When it fires, the agent reads:

```
src/a.ts:1:1 no-console-log: console.log("x", 1) leaves debug output in app code. Instead: Use `logger.info` from src/lib/logger.ts.
```

## Fields

| Field              | Required | Meaning                                                                                                             |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `id`               | yes      | A unique name. It may not be a [built-in guard](guards.md) id, and two rules may not share one.                     |
| `language`         | yes      | One of the [languages](#languages) below, or a list of them such as `[typescript, javascript]`. Case does not matter. |
| `rule`             | yes      | The ast-grep rule: `pattern`, `kind`, `has`, `inside`, `all`, `any`, `not` and the rest.                            |
| `message`          | yes      | What is wrong. `$VAR` becomes the text the metavariable matched, and `$$$VAR` the text of all the nodes it matched. |
| `instead`          | yes      | What to use instead, so the agent can fix it.                                                                       |
| `examples.invalid` | yes      | At least one code snippet the rule must fire on.                                                                    |
| `examples.valid`   | yes      | At least one code snippet the rule must not fire on.                                                                |
| `files`            | no       | Globs. When set, the rule only checks files that match one.                                                         |
| `ignores`          | no       | Globs. The rule skips files that match one.                                                                         |
| `note`             | no       | More context, shown by `cagr explain`.                                                                              |
| `constraints`      | no       | ast-grep constraints on metavariables.                                                                              |
| `utils`            | no       | ast-grep utility rules.                                                                                             |
| `transform`        | no       | ast-grep transforms.                                                                                                |
| `url`              | no       | Accepted, for your own reference.                                                                                   |
| `metadata`         | no       | Accepted, for your own reference.                                                                                   |

Globs in `files` and `ignores` are relative to the repo root and work like the [config globs](configuration.md#globs). Any other key is an error that lists the allowed keys.

A rule needs `instead` and examples on purpose. `instead` makes the block message useful. Examples make the rule testable, so a rule that silently stops matching gets caught.

### Import boundaries

To keep one part of the code from importing another, match the import's source string with a `regex` and scope the rule to the importing files with `files`. This rule keeps shared components from reaching into features, the app router or the server:

```yaml
id: components-stay-shared
language: typescript
files: ["apps/web/src/components/**"]
message: Shared components may not import from $SRC.
instead: Pass the data in as props, or move the code into src/sections/<feature>/.
rule:
  kind: string
  regex: "^['\"]@/(sections|app|api|server|layouts|store)/"
  pattern: $SRC
  inside:
    any:
      - kind: import_statement
      - kind: export_statement
examples:
  invalid:
    - import { DealCard } from "@/sections/deals/deal-card";
    - export { db } from '@/server/db';
  valid:
    - import { Button } from "@/components/button";
    - const label = "@/sections/x";
```

The string node includes its quotes, so the regex starts with `['"]`. `inside` keeps it to import and re-export sources, so a plain string with the same text does not fire. Use one rule per boundary, each with its own `files`. For rules about file names and folders, use [layout rules](#layout-rules).

## Layout rules

A layout rule has `layout:` where a code rule has `language:` and `rule:`. cagr checks the file's path only, so it is quick enough to run before an edit. This example keeps a web app's feature folders tidy:

```yaml
id: kebab-case-sections
message: Feature files use kebab-case names.
instead: Rename the file to kebab-case, such as deal-card.tsx.
layout:
  files: ["apps/web/src/sections/**/*.{ts,tsx}"]
  ignores: ["**/*.test.*"]
  name: "^[a-z0-9]+(-[a-z0-9]+)*$"
examples:
  invalid: [apps/web/src/sections/deals/DealCard.tsx]
  valid: [apps/web/src/sections/deals/deal-card.tsx]
---
id: views-in-view-folder
message: Screens live in their feature's view folder.
instead: Move it to apps/web/src/sections/<feature>/view/<name>-view.tsx.
layout:
  files:
    - "apps/web/src/sections/**/view.{ts,tsx}"
    - "apps/web/src/sections/**/*-view.{ts,tsx}"
  allowed: ["apps/web/src/sections/*/view/*-view.tsx"]
examples:
  invalid: [apps/web/src/sections/deals/deals-view.tsx]
  valid: [apps/web/src/sections/deals/view/deals-view.tsx]
```

| Field              | Required | Meaning                                                                                                       |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------- |
| `id`               | yes      | A unique name. It may not be a [built-in guard](guards.md) id, and no two rules of either kind may share one. |
| `message`          | yes      | What is wrong. Shown to the agent.                                                                            |
| `instead`          | yes      | What to do instead, so the agent can fix it.                                                                  |
| `layout.files`     | yes      | Globs, relative to the repo root, of the files the rule covers.                                               |
| `layout.ignores`   | no       | Globs of files the rule skips.                                                                                |
| `layout.name`      | no       | A regular expression the file name must match, without its extensions: `user-card` for `user-card.test.tsx`.  |
| `layout.allowed`   | no       | Globs. The only places a covered file may live.                                                               |
| `examples.invalid` | yes      | At least one repo-relative path the rule must fire on.                                                        |
| `examples.valid`   | yes      | At least one repo-relative path the rule must not fire on.                                                    |
| `note`             | no       | More context, shown by `cagr explain`.                                                                        |

A rule needs `layout.name`, `layout.allowed` or both. When the agent is about to create a file that breaks one, `file.before_edit` denies it with the rule's message, what failed and what to do instead:

```
Do not create apps/web/src/sections/deals/DealCard.tsx: Feature files use kebab-case names. (the name "DealCard" does not match /^[a-z0-9]+(-[a-z0-9]+)*$/.) Instead: Rename the file to kebab-case, such as deal-card.tsx. (cagr: kebab-case-sections)
```

When a path breaks more than one rule, the message lists every fix. Only files made with the agent's edit tools are checked before they exist; a file made by a shell command (`mv`, `touch`, a generator) is caught by `cagr check` and `cagr ci`.

Edits to a file that already exists are not denied, so old files can still be fixed. They are reported after the edit, at the end of the turn, by `cagr check` and as the Layout check in `cagr ci`. If a rule file is broken, no layout rule runs before an edit, and the Rules check reports the problem.

## Languages

| `language`   | Files it checks                                              |
| ------------ | ------------------------------------------------------------ |
| `typescript` | `.ts`, `.mts`, `.cts`, and `.tsx` (read with the TSX parser) |
| `tsx`        | `.tsx`                                                       |
| `javascript` | `.js`, `.mjs`, `.cjs`, `.jsx`                                |
| `html`       | `.html`, `.htm`                                              |
| `css`        | `.css`                                                       |
| `python`     | `.py`, `.pyi`                                                |
| `go`         | `.go`                                                        |
| `rust`       | `.rs`                                                        |

A rule only checks files whose extension one of its languages reads. With a list, such as `language: [typescript, javascript]`, one rule covers `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs` and `.cjs`. When two languages read the same extension, the first one in the list reads it.

A rule may use node kinds that only some of a language's parsers have. JSX kinds such as `jsx_opening_element` exist in the TSX parser, not the plain TypeScript one, so a `typescript` rule that uses them checks `.tsx` files and skips `.ts` files. A kind that none of a language's parsers have, such as `type_annotation` under `javascript`, is a rule file problem that names the language. Examples are read with the first parser the rule works in.

 The Python, Go and Rust parsers are built into the binary. On first use, cagr writes them to `~/.cache/cagr/<version>/` (or `$XDG_CACHE_HOME/cagr/<version>/`, or `%LOCALAPPDATA%\cagr\<version>\` on Windows).

## When rules run

- After each edit, on the edited file (`file.after_edit`).
- At the end of a turn, on every file changed in the turn (`turn.end`).
- In `cagr check <files...>`, and on every file in `cagr check --all`.
- In `cagr ci`, on the branch's changed files.

If a rule file has a problem (bad YAML, a missing field, a duplicate id, a kind or regex ast-grep rejects), every rule check fails with one message that lists each problem, for example:

```
Rule files have problems:
  - .cagr/rules/r.yml (no-print): "instead" is required: say what to use instead, so the agent can fix it.
```

`cagr doctor` reports this under Config.

## `cagr rules test`

Runs every rule against its own examples. Each `invalid` example must fire and each `valid` example must not. For a layout rule the examples are paths, checked against `files`, `ignores`, `name` and `allowed`.

```
$ cagr rules test
2 rules, 4 examples, 0 failed.
```

A failure names the rule and the example:

```
FAIL no-console-log: invalid example did not fire:
  console.log("hi")
FAIL no-console-log: valid example fired 1 time:
  logger.info("hi")
```

It exits 1 when any example fails. Run it in your `verify` script or in CI.

## `cagr check <files...>`

Runs what the agent hooks run on files, outside an agent: the [protected-file](guards.md#protected-file) check, the `on_edit` commands of each stack that covers the files, the code rules and the [layout rules](#layout-rules). Use it to try a new rule or glob.

```
$ cagr check src/a.ts
## Rules
src/a.ts:1:1 no-console-log: console.log("x", 1) leaves debug output in app code. Instead: Use `logger.info` from src/lib/logger.ts.
```

It exits 1 when it finds a problem. Otherwise it prints "No problems in N files." Note that `on_edit` commands run for real, so a formatter with `--write` changes the files.

## `cagr check --all`

Rules run on changed files only, so old code that breaks a new rule stays hidden until someone edits it. `cagr check --all` runs the code rules and the [layout rules](#layout-rules) over every file git tracks or would track (files your `.gitignore` excludes are skipped). Use it when you move an existing checker into cagr, and add it to your `verify` script to keep the whole repo clean.

```
$ cagr check --all
## Rules
src/old.ts:1:1 no-console-log: console.log(1) leaves debug output in app code. Instead: Use `logger.info` from src/lib/logger.ts.

## Layout
src/OldName.ts kebab-files: Files use kebab-case names. (the name "OldName" does not match /^[a-z0-9]+(-[a-z0-9]+)*$/.) Instead: Rename it.
```

It exits 1 on any finding, or prints "No problems in N files." It does not run `on_edit` commands, since those may change files; your `verify` script runs your linters on the whole repo already. It does not take file names; `cagr check <files...>` is for that.

## `cagr explain <id>`

Prints a rule's message, what to do instead, its note, and its examples:

```
$ cagr explain no-console-log
no-console-log (typescript rule from .../.cagr/rules/r.yml)

Message: console.log($$$ARGS) leaves debug output in app code.
Instead: Use `logger.info` from src/lib/logger.ts.

Fires on:
  console.log("hi")
Allows:
  logger.info("hi")
```

It also explains built-in guards, and [layout rules](#layout-rules) with their files and the name or places they allow. An unknown id lists every known guard and rule id.
