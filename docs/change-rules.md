---
title: Change rules
nav_order: 7
---

# Change rules

Change rules are cagr's own rule type. They check a branch's change: which files
must change together, which existing files must stay fixed, and which new files
need a companion. Keep snapshot checks in your linter. Use [code rules](code-rules.md)
with ast-grep as a fallback for patterns your linter cannot express. Code and
layout rules keep working alongside change rules.

Put rules in `cagr.toml` or `.cagr/changes.toml`. Lists add across fragments and
presets, even when another fragment has an empty list. In `pyproject.toml`, use
`[[tool.cagr.changes.rules]]`.

```toml
[[changes.rules]]
id = "schema-companion"
kind = "requires"
paths = ["src/config/schema.ts"]
require = ["schema/cagr.schema.json"]
reason = "Run `bun run schema` and include schema/cagr.schema.json in this change."
examples.invalid = [{ changes = [{ path = "src/config/schema.ts", status = "M" }] }]
examples.valid = [{ changes = [{ path = "src/config/schema.ts", status = "M" }, { path = "schema/cagr.schema.json", status = "M" }] }]

[[changes.rules]]
id = "guard-tests"
kind = "sibling"
paths = ["src/guards/**/*.ts"]
ignores = ["**/*.test.ts"]
target = "{dir}/{name}.test.{ext}"
reason = "Add or update the matching test in this change."
examples.invalid = [{ changes = [{ path = "src/guards/new.ts", status = "A" }] }]
examples.valid = [{ changes = [{ path = "src/guards/new.ts", status = "A" }, { path = "src/guards/new.test.ts", status = "M" }] }]

[[changes.rules]]
id = "migration-history"
kind = "add_only"
paths = ["migrations/**"]
reason = "Restore the merged migration and add a new migration instead."
examples.invalid = [{ changes = [{ path = "migrations/001.sql", status = "D" }] }]
examples.valid = [{ changes = [{ path = "migrations/002.sql", status = "A" }] }]
```

Every rule needs a unique `id`, nonempty `paths`, a nonblank `reason` saying what
to do instead, and at least one valid and invalid fixture. `note` is optional.
`ignores` removes triggers only. All matching rules run.

- `requires`: any selected change, including deletion, requires every `require`
  glob to match an added or modified regular file in the result.
- `add_only`: paths present at the merge base cannot change content, mode, type
  or location. Files first added on the branch can still be revised.
- `sibling`: every added selected file needs an added or modified regular file at
  its exact expanded `target`. `{dir}` is its directory, `{name}` removes only
  the last extension, and `{ext}` is that extension without a dot. Root paths
  omit the joining slash. Substitutions are literal, including glob characters.

Paths use the existing glob behavior: slash patterns are relative to the config
root, basename patterns match anywhere, braces give alternatives. There are no
implicit test exclusions. Targets reject globs, absolute paths, unknown
placeholders and `..` components.

Run `cagr rules check [--base <ref>]` for the working tree or add `--committed`
for HEAD. Neither command prepares a PR gate. `cagr rules test` runs fixtures
through the same pure evaluator, with no Git or shell calls. Fixture statuses are
`A`, `M`, `D`, `T`; paths must be unique. Optional `before` and `after` strings
are accepted only on sides that exist. `cagr explain <id>` shows the source,
selector, obligation and examples. `cagr doctor` validates configuration and
fixtures and reports baseline availability and measured collection times.

At turn end the range is the unique merge base of the target and HEAD to the
working tree. It includes committed branch work, staged and unstaged net content,
deletions, and nonignored untracked files, including shell writes. It does not
claim that this session authored every change. Staging is not a second endpoint:
staged content reverted in the working tree cannot satisfy an obligation.
Pending staged content is reported separately. CI uses merge base to HEAD only,
evaluates before formatters, and rejects dirty checkouts and a checkout that does
not equal the PR event head SHA. Collection rebuilds a temporary index from staged
identities, lets Git capture the working tree, and compares that tree to the merge
base. This avoids cached timestamps and index flags hiding edits and records
symlinks rather than reading their targets. It writes temporary index and Git
object data, never the user's index, worktree or refs.

Local base selection is `--base`, `git.protected_branch`, then `main`. CI also
uses nonempty `GITHUB_BASE_REF` before the configured branch. Resolution tries
`origin/<ref>` before the local ref. No hook fetches history. A local target does
not prove remote freshness; rerun CI against an updated target after rebase.
Renames are deletion plus addition. Content, mode and type count, not timestamps.
Symlinks and submodules cannot satisfy a required regular companion.

Missing or shallow history, ambiguous merge bases, conflicts, collection races,
and exceeded limits are unchecked. Hooks allow errors with a notice. Known
violations block two stops, then allow with a human notice. Commands and CI exit
nonzero on unchecked results or findings. Turn checks share a 55 second deadline,
leaving time under the 60 second budget for output and state. Collection retries
one race, caps Git output at 8 MB, changed paths at 20000, changed regular files
at 32 MB each, rules at 1000, and evaluation at two million glob comparisons.
Output limits retain complete fixes.

Co-change proves that a companion changed, not that it is correct. This repo's
schema equality test verifies the generated schema separately. A matching test
file also does not establish test quality. PR text, dependency selectors, gate
records and merge queue metadata are outside this release.
