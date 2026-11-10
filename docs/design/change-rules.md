# Change rules

Status: proposal. None of the configuration or commands added below exists yet.

## Recommendation

Make change rules cagr's main custom rule type. A linter judges a snapshot;
change rules judge the difference between two snapshots and the description of
that difference. Start with four kinds: `requires`, `add_only`, `sibling`, and
`pr_body`. Use one pure evaluator in hooks, local checks and CI. Keep code and
layout rules working, but move ast-grep out of the headline. Do not silently
translate existing rules or remove ast-grep in this work.

Use the branch merge base, not session start, as the baseline. A session can
start halfway through a change, span several commits, or share a worktree with
another agent. Restarting it must not erase an obligation. At turn end, include
the current working tree. Before creating a PR and in CI, check committed trees.
The PR command hook reads a prepared result so it can stay under 50ms.

## What exists today

The relevant boundaries are:

- [Configuration](../configuration.md) and `src/config/schema.ts` define keys
  through `obj`, `arr`, `oneOf` and scalar nodes. `.cagr/**/*.toml` fragments
  already join the root config. Lists of tables add up across fragments and
  presets. `.cagr/review-evals/` is not config.
- `src/hook/handlers.ts` records edit-tool paths and runs turn checks only when
  `needsCheck` says those paths need checking. `src/turn-state.ts` holds paths
  and a failed-stop count, not a Git baseline. Shell edits can be missed.
- `src/ci.ts` resolves a base and merge base, then lists changed paths with
  deletions excluded. That list is suitable for reading source files, but
  insufficient for change rules. Its generated-files check checks `sync`
  outputs, not whether `schema/cagr.schema.json` matches `bun run schema`.
- `src/risk.ts` classifies paths. It does not inspect dependency changes or
  establish whether a PR gives a reason. `[review].pr_sections` checks headings,
  rather than a conditional requirement for text under a heading.

This proposal adds a separate change input. It does not redefine the file lists
passed to formatters, which still need files that exist.

## Four kinds, one small selector

Every rule has a unique `id`, `kind`, nonempty `paths`, and a nonblank `reason`.
The reason must say what to do instead. `ignores` defaults to `[]` and removes
trigger paths, never required companion paths. `note` is optional explanation.
All matching rules run. There is no rule ordering, scripting language, automatic
fix, severity setting or model call.

| Kind | Trigger and requirement | Example covered |
| --- | --- | --- |
| `requires` | If any selected path changes, every entry in `require` must match at least one added or modified path that still exists in the result. | A schema source change needs a generated schema change. |
| `add_only` | A selected path present in the baseline must keep the same content, type and mode at the same path. New paths are allowed. | Existing migrations cannot be edited, removed or renamed. |
| `sibling` | Every added source path needs its own expanded `target` path added or modified in this change and present in the result. | A new guard needs a test in the same change. |
| `pr_body` | If the selector fires, a named PR section must contain substantive text and, optionally, literal `contains` text. | A new dependency needs a reason under Risk. |

`requires` and `pr_body` accept `when = "changed"` (default) or
`when = "dependency_added"`. The latter is a deliberately narrow selector:
parse the before and after JSON of matching `package.json` files and compare
package names in `dependencies`, `devDependencies`, `optionalDependencies` and
`peerDependencies`. An entry absent from its old section and present in its new
section triggers, including moves between sections. Version-only changes and
removals do not. A newly added manifest starts with empty sections. Deleting a
manifest adds no dependencies. Invalid JSON or a non-object dependency section
is a check error, not an empty dependency list. Other manifest formats, JSON
queries, diff regexes and semantic code selectors are outside the first design.

The schema example proves co-change only. Touching a generated file, or editing
it incorrectly, must not be described as proof of regeneration. This repo already
has `src/config/json-schema.test.ts`, which compares the saved JSON with
`jsonSchema()` as parsed data and runs through `bun run verify`. Keep that test
as the equality backstop; consider running the focused test at turn end too.
Other repos can put a read-only generator comparison in `stack.on_turn_end`
and CI, with no writes during verification. Do not add an arbitrary command
runner to each change rule.

The CLI/config documentation example is left out as stated. `src/**` cannot
tell a new command from a bug fix. A broad `requires` rule for all source edits
would demand meaningless docs edits. An owner can choose a narrower explicit
path policy, but the promise that new user behavior has adequate docs remains
in review. Likewise, a matching test file does not prove the test is useful,
and text in Risk does not prove the reason is sound.

### Paths and templates

Use the existing `matchesGlob` behavior: `/` paths from the config root, patterns
without a slash match basenames anywhere, braces give alternatives. Use
`/package.json` for only the root manifest; `package.json` also matches workspace
manifests. Internally use repo-relative paths with `/`, case-sensitive matching,
and no leading slash. No implicit test exclusions or negated globs: use `ignores`.

Only `sibling.target` accepts templates. For `src/guards/no-push.ts`, `{dir}` is
`src/guards`, `{name}` is `no-push` (remove the last extension), and `{ext}` is
`ts`. Thus `{dir}/{name}.test.{ext}` is `src/guards/no-push.test.ts`. For
`x.test.ts`, the name is `x.test`, unlike layout rules' extension stripping.
For a root file, `{dir}` is empty and the joining slash is removed. Substituted
characters are literal path characters, not glob syntax. The target is one
exact path. Reject unknown placeholders, glob syntax in the target, absolute
targets and `..` components. Templates do not capture glob groups.

## Configuration and examples

Use `[[changes.rules]]` in `cagr.toml`, or conventionally
`.cagr/changes.toml`. Under `[tool.cagr]`, use `[[tool.cagr.changes.rules]]`.
There is no separate loader or YAML format for change rules. An absent rules
list means no change checks, preserving current configs. Reserve ids across
built-in guards, code, layout and change rules; duplicates report both sources.

The following are proposed configurations, not settings to paste into today's
cagr:

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
reason = "Add or update the matching .test.ts file in this change."
examples.invalid = [{ changes = [{ path = "src/guards/new-guard.ts", status = "A" }] }]
examples.valid = [{ changes = [{ path = "src/guards/new-guard.ts", status = "A" }, { path = "src/guards/new-guard.test.ts", status = "A" }] }]

[[changes.rules]]
id = "immutable-migrations"
kind = "add_only"
paths = ["migrations/**"]
reason = "Restore the merged migration and add a new migration instead."
examples.invalid = [{ changes = [{ path = "migrations/001.sql", status = "M" }] }]
examples.valid = [{ changes = [{ path = "migrations/002.sql", status = "A" }] }]

[[changes.rules]]
id = "dependency-reason"
kind = "pr_body"
paths = ["package.json"]
when = "dependency_added"
section = "Risk"
contains = "Dependency reason:"
reason = "In the PR body's Risk section, write `Dependency reason:` and explain why the new dependency is needed."
examples.invalid = [{ changes = [{ path = "package.json", status = "M", before = '{}', after = '{"dependencies":{"x":"1"}}' }], pr_body = "## Risk\nNone" }]
examples.valid = [{ changes = [{ path = "package.json", status = "M", before = '{}', after = '{"dependencies":{"x":"1"}}' }], pr_body = "## Risk\nDependency reason: x reads the required wire format." }]
```

`contains` is a case-sensitive literal within that section, not a regex.
Headings are case-insensitive exact visible text on ATX level 2 headings outside
fenced code. A section ends at the next level 1 or 2 heading. Ignore comments,
blank lines, a repeated marker alone, and standalone placeholders such as `TODO`,
`TBD`, `N/A` or `None`. With `contains`, require non-placeholder text after the
marker within the section. Reject duplicate matching sections to avoid checking
one while a person reads another. Share this parser with `pr_sections`, retaining
the latter's unconditional heading-only meaning. This is a structural check,
not a language model's judgment of the explanation.

In `schema.ts`, define the rules array with `arr(oneOf([...]))`, one strict
`obj` per literal `kind`. Reuse shared field nodes, require kind-specific keys,
and reject unrelated keys. Use `str({ minLength: 1 })`, then validate trimmed
strings, nonempty lists, ids, templates and fixtures during config resolution.
The current DSL can express the objects and unions; do not create a parallel
schema engine. Add `changes.rules` to the loader's additive table-list keys,
including the empty-list case. Defaults and `Config` must agree. Regenerate the
editor schema and test it with the normal schema command when implementing.

Fixtures belong inside each rule, so `.cagr/**/*.toml` has no new exception
folder. Every rule needs at least one valid and one invalid example. `changes`
contains unique paths with `A`, `M`, `D` or `T` status. These imply absence or
presence before and after. Optional `before`/`after` strings provide content;
the dependency selector requires content on each side that exists. Impossible
fixtures, such as an addition with `before`, are config errors. `pr_body` is
optional, and omission represents unavailable metadata. Examples run in the CI
phase by default; an optional `phase = "turn"` tests deferred PR requirements.
This fixture notation is a test adapter to the shared evaluator, not a second
runtime diff format.

## What is the change?

Let `T` be the resolved target commit and `H` the result commit. Let `B` be their
unique merge base. Reuse current base precedence for CI: `--base`, then nonempty
`GITHUB_BASE_REF`, then `git.protected_branch`, then `main`. Local checks use
`--base`, then `git.protected_branch`, then `main`. Reuse `resolveBase`'s
`origin/<name>` then local-name lookup. Store resolved SHAs, not just names.
Missing history, no base, or multiple merge bases is an unchecked result; do
not fall back to HEAD or an empty tree. Local hooks never fetch.

| Event | Baseline and result | Staged, unstaged, untracked, deleted |
| --- | --- | --- |
| `turn.end` | `B = merge-base(T, HEAD)` to the current working-tree snapshot `W`. No session-start diff. | Include net tracked working-tree content and nonignored untracked files. Include deletions and type/mode changes. See index handling below. |
| `command.before` for `gh pr create` | Prepared `B` to the selected local head `H`, using the command's explicit `--base` and `--head` if supplied. | Committed changes only. A companion left staged or untracked cannot satisfy the PR rule. Deleted committed paths remain in the input. |
| `cagr ci` | `B` to checked-out `H`, using the event's target ref. | Committed trees only. Ignore local dirt for rule evaluation. Fail the CI check separately if its checkout is dirty or edit checks dirty it. |

At turn end, stage state is not a second diff to union with the working tree.
A staged addition still present in the working tree is an addition; a staged
edit reverted in the working tree is no net edit against the baseline unless
HEAD already differs. Index-only changes are reported separately as pending
staged content, with the instruction to stage the intended result and rerun the
committed check before opening a PR. They cannot satisfy a companion missing
from `W`. An added-then-deleted file absent from both endpoints is no change.
Ignored untracked files do not count; ignored files already tracked still do.
Unmerged index entries make the snapshot unchecked until conflicts are resolved.

Build a NUL-delimited Git change list and include old and new identities. Turn
checks use a no-renames diff of `B` against the working tree plus
`git ls-files --others --exclude-standard -z`. Committed checks use a no-renames
diff of the two trees. Disable copy detection too. A rename is deletion plus
addition, independent of Git's similarity heuristics. Renaming an old migration
therefore fails; renaming a guard creates a new sibling obligation. A deleted
trigger fires `requires`, but a deleted companion does not satisfy it. `sibling`
only fires for additions; a matching existing test must change to count.

Compare actual content, modes and types, not timestamps. An identical rewrite
does not count. A new symlink or submodule may not stand in for a required
regular test or generated file. Read only manifest blobs needed by semantic
selectors, never follow symlinks outside the root. Reject a snapshot that changes
during collection and retry once within the deadline; otherwise mark unchecked.
Use a temporary index or read-only comparisons, never modify the user's index,
working tree or refs while collecting `W`.

`add_only` freezes paths present in `B`, so a migration first added on this branch
can be revised until merge. It does not establish which migrations were applied
to a database, nor see target commits the local clone has not fetched. Require
an up-to-date branch or merge-queue validation for final protection against target
movement. Recheck against the updated baseline after rebase. CI must not report
a stale local target as current remote policy.

For ordinary PR events require the checkout to equal the event's head SHA;
checking GitHub's synthetic merge commit would change the meaning. A merge queue
has its own integration tree and base SHA: evaluate file rules for that range,
but report PR metadata separately as described below.

## Checks at each event and budgets

At turn end, run file change rules even if no edit-tool paths were recorded.
They must see shell writes, deletions and commits made during the session. Keep
the existing path-based stack checks, but do not put change rules behind their
`needsCheck` early return. Do not block halfway through editing a companion.
`pr_body` triggers produce an advisory at turn end: the agent may have no PR
body yet. They block only when a PR body is actually required at a PR gate or CI.

Run snapshot collection and pure rule evaluation within one whole-hook deadline
under 60 seconds, sharing time with existing checks. Reserve time for rendering
and cleanup; cap changed paths, manifest bytes, rule count, body bytes and output.
Exceeding a cap reports unchecked, never a partial pass. Record collection and
evaluation timings separately. The current per-command 60-second timeouts plus
later rule work are not a whole-hook deadline; implementation must account for
this rather than adding another 60-second allowance.

Add `cagr rules check [--base <ref>]` to run the working-tree check and
`cagr rules check --committed [--base <ref>]` to check HEAD and prepare a gate
record. Successful turn checks can also prepare a distinct committed record
when budget permits. Never reuse a working-tree pass for a committed result.
The record stores trigger evidence, findings, deferred body obligations, and
resolved repository/worktree identity, `T`, `B`, `H`, cagr version and a digest
of the effective change-rule config. It can store failures as well as passes.
Write atomically to per-worktree Git state, not a tracked config fragment.

The PR command hook does no full diff, generator, model call or network request.
Reuse the existing command parser's cwd, `gh -R`, `--repo`, head and base handling;
validate the local repository and selected head before using the record. A
foreign head without a matching local context is unchecked. Evaluate body
obligations independently of `[review].enabled`, then compose with the existing
review gate. Disabling AI review must not disable change rules.

Fit ref resolution, record read, effective-config validation and body parsing
inside the existing whole `command.before` budget of 50ms. Measure compiled
binary timings on representative repos; parsing many fragments may itself
exceed that budget. On a cache miss, stale record, timeout or unresolvable
command, allow with an explicit unchecked notice asking for
`cagr rules check --committed --base <target>` and rely on CI. Do not deny merely
because a cache is missing: that would turn infrastructure failure into a rule
violation. Known, current findings deny with the fix. Ref movement or config
changes invalidate a record even when HEAD did not change. Dirty files are
irrelevant to the committed record; they will not enter this PR until committed.

Use explicit `--body` or a bounded local `--body-file`, parsed as data. Do not
execute substitutions, read stdin `--body-file -`, or open an editor inside the
hook. Unavailable body input is unchecked with instructions to use a body file;
an available empty body is a violation if an obligation fires. Report this gap,
including interactive or `--fill` creation, rather than claiming all PRs were
checked. The same prepared range can serve `gh pr ready`, but without an explicit
body it needs CI to validate current remote text. Nested shell commands and
other PR clients retain the existing command guard's visibility limits.

CI rebuilds the committed input without trusting local records. Add a distinct
`Change rules` check and path annotations, including deleted paths where possible.
Evaluate before formatters, so their writes cannot supply missing companions.
Use event PR metadata, not `gh` in the hook. Run on PR body edits too, since a
body can become invalid without a new commit. Where no PR metadata exists,
report body obligations as unchecked, not passed. If any such obligation fires,
`cagr ci` exits nonzero with an instruction to run in a PR context. File-only
checks still work in other CI systems. Initial merge-queue support must either
collect and validate each constituent PR's body against its own diff, or fail
that metadata check explicitly; do not bless the batch with one arbitrary body.

## Messages and commands

Show the rule id, trigger, missing requirement, range and configured fix. For
example:

```text
Change rule schema-companion failed (merge base abc123 to working tree).
src/config/schema.ts changed; schema/cagr.schema.json did not change.
Instead: Run `bun run schema` and include schema/cagr.schema.json in this change.

Change rule guard-tests failed.
Added src/guards/no-push.ts; src/guards/no-push.test.ts needs to change too.
Instead: Add or update the matching .test.ts file in this change.

Change rule immutable-migrations failed.
migrations/001.sql existed at the baseline and was deleted.
Instead: Restore the merged migration and add a new migration instead.

Change rule dependency-reason failed.
Added dependencies.x in package.json; Risk lacks a dependency explanation.
Instead: In the PR body's Risk section, write `Dependency reason:` and explain why the new dependency is needed.

Unchecked: change rules could not read the branch baseline.
Fetch the target branch, run `cagr rules check --committed --base main`, and rerun CI.
This hook call was allowed; no passing result was recorded.
```

`cagr explain <id>` shows kind, source file, paths, exclusions, template or
required section, reason, note, examples, and which events defer the rule. The
session brief lists ids and short obligations. Use the existing output limits
and deduplication, keeping at least one complete fix and a count of omitted
findings. Never truncate a reason into an instruction with its action missing.

`cagr doctor` validates the combined config, examples and templates, reports the
resolved base and whether history is available, and reports measured hook times.
It shows stale gate records as stale, not policy failures. It should identify
rules whose trigger globs match no tracked paths as advice, since future-path
rules can be intentional. It must distinguish unchecked from passing.

`cagr init` can write commented examples in `.cagr/changes.toml` when obvious
repo structure supports them. Do not enforce guessed policies automatically.
Parsing AGENTS.md into mandatory rules is not worth doing in phase one: advice
contains exceptions, intent and fuzzy phrases that a deterministic rule cannot
recover. Later, an explicit suggestion mode could show source quotes and draft
rules with fixtures for a person to edit. No model call in normal init or hooks.

Extend `cagr rules test` to test change fixtures alongside code and layout
examples, using the same evaluator, with no Git, shell commands or network.
An invalid example must produce that rule's finding; a valid example must not.
Unchecked is a test failure in both cases, never evidence that a valid example
passed. Report per-kind counts and the failing fixture. `cagr check --all` stays
a snapshot operation; it cannot truthfully test a change without a baseline.

Hooks retain fail-open: config, Git, parsing, timeout and evaluator errors let
the call through, tell the human which rule or stage was unchecked, and never
write a success record. Other independent valid rules can still run if input
is complete. Known findings use the current two blocked stops, followed by the
third-stop human notice; that escape does not create a pass. Explicit commands,
`doctor`, `rules test` and CI exit nonzero on invalid config or incomplete checks.
Hook fail-open does not imply CI success. No extra exception mechanism in v1.

## Delivery phases

1. Build the diff input and pure evaluator for `requires`, `add_only` and
   `sibling`. Add TOML schema, fragments, fixtures, `explain`, `rules test` and
   local `rules check`. Validate deletions, untracked files and companion rules
   on cagr itself before turning them on. Keep runtime behavior opt-in.
2. Wire turn end and CI to that evaluator, including whole-hook deadlines,
   distinct unchecked reporting and the stop-loop escape. Retain the existing
   generated-schema equality test. Ship this useful file-rule subset first.
3. Add `pr_body`, the bounded dependency selector, shared section parsing and
   committed gate records. Integrate `gh pr create`, body-edit CI events and
   explicit merge-queue metadata handling. Test cache invalidation and the
   under-50ms path before claiming early PR enforcement.
4. Move README and comparison docs to lead with change rules and show setup,
   fixes and limits. Keep code/layout rule docs and existing configs supported.
   Consider AGENTS.md suggestions only after real rules show recurring patterns.

## Acceptance tests for implementation

These are future tests, not claims that this design PR implements them.

| Area | Cases and expected result |
| --- | --- |
| Co-change | Schema source only fails; source plus generated edit passes; missing, deleted or identical-rewritten companion fails; two `require` entries each need a match; unrelated docs edit does not satisfy the schema path. |
| Siblings | New guard alone fails; matching added or modified test passes; unchanged existing test fails; deleted test fails; existing guard edit creates no new-file obligation; test additions are excluded; multiple guards each need a test. |
| Add only | Old migration edit, deletion, mode/type change and rename fail; new migration and further edits to that branch-new migration pass; new then removed is no net change; rebase makes a now-merged migration immutable. |
| Dependencies | Addition in each of the four sections triggers; workspace manifests match; version edit/removal does not; section move triggers; new manifest triggers; deleted manifest does not; malformed JSON, oversized content and symlink input are unchecked. |
| PR text | Missing heading, blank body, placeholders, marker alone, marker in another section, fenced headings and comments fail; a real explanation after the marker in Risk passes; duplicate Risk fails; unavailable body is unchecked. |
| Snapshot | Committed, staged, unstaged and nonignored untracked additions behave as defined; staged-only content cannot hide a working-tree failure or satisfy a PR; deletions survive collection; shell-only edits run at stop; ignored untracked files do not count. |
| Range | Restart session and make multiple commits without losing obligations; initial dirty work is included and labeled; concurrent edits are included without claiming authorship; switching branch or worktree invalidates cache; missing/shallow history and multiple merge bases are unchecked. |
| Git details | Spaces, tabs, newlines and glob characters in filenames survive NUL parsing; rename is D+A; mode and symlink/submodule changes are preserved; conflict entries are unchecked; collection races retry once then report unchecked. |
| Config | Root, pyproject and nested fragments agree; empty arrays do not erase inherited rules; duplicate ids across all rule kinds fail; unknown keys, empty reasons, bad fixtures and escaping templates fail; regenerated schema matches. |
| Events | Companion may be edited later in the turn; first two violating stops block and third escapes with notice; deferred PR obligation does not block stop; review disabled still checks change rules; CI catches edits made with hooks off. |
| Gate | Same head with changed target/config/version cannot reuse a pass; dirty companion cannot satisfy committed diff; explicit cwd/head/base/repo target is respected; missing/stale/error cache allows with notice; current failure denies; body file is bounded and never executed. |
| CI | Exact PR head is checked; dirty checkout cannot manufacture a pass; body-only edit reruns metadata validation; non-PR or merge-queue metadata missing for an active obligation is unchecked and nonzero; each constituent PR is checked if batch support is added. |
| Tools | Examples use the runtime evaluator and detect deliberately broken matching; explain names source and scope; doctor separates violations, errors and deferred checks; output cap retains a complete fix; no check mutates index, refs or user files. |
| Budgets | Measure cold and warm compiled hooks in small and large repos, including many fragments and thousands of paths; command hook remains below 50ms or visibly fails open; stop work shares a deadline below 60s; cap/timeout never yields a pass. |

## Questions for the owner

- Is strict co-change acceptable when a schema source edit produces identical
  JSON? This design deliberately requires a companion diff; equality-only
  verification would allow that case and may eventually replace this rule.
- Should moving a package between dependency sections need a new explanation?
  This proposal says yes; version changes do not trigger.
- Is an explicit `Dependency reason:` marker acceptable, or should Risk merely
  require text? The marker makes the check predictable but cannot judge quality.
- Should merge queues initially fail active PR-body obligations until metadata
  collection ships, or should that feature wait until queues are supported?

The cache-miss fail-open behavior and inclusion of existing branch work at turn
end are recommendations, not hidden implementation details. They trade strict
local gating and per-session attribution for the stated budgets and consistent
branch semantics. CI remains the place to require a complete result.
