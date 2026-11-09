---
title: Code rules
nav_order: 6
---

# Code rules

Code rules catch patterns in your code that a linter does not know about, like a `console.log` in app code or a raw SQL call outside the data layer. They are [ast-grep](https://ast-grep.github.io/) rules, so they match the syntax tree, not text. cagr runs them after each edit and at the end of each turn, on the changed files only, and again in CI.

Biome `.grit` rules stay in Biome. Run Biome from `on_edit`.

## Where rules live

Put rule files in `.cagr/rules/`. cagr reads every `*.yml` and `*.yaml` file in that folder and its subfolders. To use other folders, set `[rules] dirs`:

```toml
[rules]
dirs = [".cagr/rules", "tools/rules"]
```

A file can hold one rule, or several separated by `---`.

## A rule

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
| `language`         | yes      | One of the [languages](#languages) below. Case does not matter.                                                     |
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

The string node includes its quotes, so the regex starts with `['"]`. `inside` keeps it to import and re-export sources, so a plain string with the same text does not fire. Use one rule per boundary, each with its own `files`. For rules about file names and folders, use [layout rules](configuration.md#layout).

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

A rule only checks files whose extension its language reads. The Python, Go and Rust parsers are built into the binary. On first use, cagr writes them to `~/.cache/cagr/<version>/` (or `$XDG_CACHE_HOME/cagr/<version>/`, or `%LOCALAPPDATA%\cagr\<version>\` on Windows).

## When rules run

- After each edit, on the edited file (`file.after_edit`).
- At the end of a turn, on every file changed in the turn (`turn.end`).
- In `cagr check <files...>`.
- In `cagr ci`, on the branch's changed files.

If a rule file has a problem (bad YAML, a missing field, a duplicate id), every rule check fails with one message that lists each problem, for example:

```
Rule files have problems:
  - .cagr/rules/r.yml (no-print): "instead" is required: say what to use instead, so the agent can fix it.
```

`cagr doctor` reports this under Config.

## `cagr rules test`

Runs every rule against its own examples. Each `invalid` example must fire and each `valid` example must not.

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

Runs what the agent hooks run on files, outside an agent: the [protected-file](guards.md#protected-file) check, the `on_edit` commands of each stack that covers the files, the code rules and the [layout rules](configuration.md#layout). Use it to try a new rule or glob.

```
$ cagr check src/a.ts
## Rules
src/a.ts:1:1 no-console-log: console.log("x", 1) leaves debug output in app code. Instead: Use `logger.info` from src/lib/logger.ts.
```

It exits 1 when it finds a problem. Otherwise it prints "No problems in N files." Note that `on_edit` commands run for real, so a formatter with `--write` changes the files.

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

It also explains built-in guards and [layout rules](configuration.md#layout). An unknown id lists every known guard and rule id.
