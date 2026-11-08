---
title: Review
nav_order: 7
---

# Review

`cagr review` reviews the branch against its base with a reviewer agent: Claude Code or Codex, started read-only in a fresh context, with its own hooks turned off. It reads `REVIEW.md` (what matters in this repo), the diff, the commit messages and the risk tier, and it can read any other file in the repo that it needs.

With review on, the [review gate](guards.md#review-gate) denies `gh pr create` and `gh pr ready` until the current commit has passed a review. The loop for an agent is:

1. Commit.
2. Run `cagr review`. It takes a few minutes, so give the command a 15 minute timeout.
3. Fix each Important finding and commit, or [answer](#answers) it.
4. Run `cagr review` again. After round 1 it reviews only the new commits.
5. Open the pull request when no Important finding is open.

The `recommended` preset turns review on. Without a preset, set `[review] enabled = true`.

## Running a review

```sh
cagr review                      # review the branch's commits since its base
cagr review --base develop       # compare with another base branch
cagr review --full               # review the whole branch again, not just new commits
cagr review --effort deep        # pick the effort for this run
```

Before it starts:

- Tracked files must be committed. If not: "Commit your changes first. The review covers commits, and the gate checks the commit you open the pull request from."
- The base is `--base`, else `[git] protected_branch`, else `main`. cagr uses `origin/<base>` if it exists, else the local `<base>`. If it finds neither: "Cannot find the base branch "develop". Fetch it, or pass --base <branch>."
- If the branch has no commits beyond the base, there is nothing to review.
- If the current commit was already reviewed, it says so and does not run again, unless you pass `--full`.

The diff leaves out files that match `[review] skip`. A diff over 150,000 characters is cut, with a note and a `--stat` summary. The commit log is cut at 6,000 characters.

A report looks like this:

```
Round 2 (diff, standard, medium risk, claude): 1 important, 1 nit.

Fixed since the last round:
- f1 src/deals.ts:42  ...

Important:
- f3 src/deals.ts:88  ...
  The evidence: which input, and what happens.
  Class: .... Check for the same problem elsewhere.

Nits (optional):
- f4 ...

Next: fix each Important finding, commit, and run `cagr review` again. It reviews only the new commits. ...
```

When nothing Important is open, it ends with "Passed. No Important finding is open, so the gate lets the pull request through."

Exit codes: 0 passed, 1 Important findings open, 2 error (including a reviewer that could not run, and bad arguments).

## Effort

Effort sets how many agents look at the change.

| Effort     | Finders                                               | Verifiers                                          |
| ---------- | ----------------------------------------------------- | -------------------------------------------------- |
| `quick`    | one bug finder                                        | none                                               |
| `standard` | a bug finder and a security finder                    | one, which drops what it cannot confirm            |
| `deep`     | a bug finder, a security finder and a behavior finder | three, and a finding stays when at least two agree |

With `[review] security = false`, the security finder is replaced by a behavior finder in `standard`, and `deep` runs a bug finder and a behavior finder.

Which effort runs:

1. `--effort`, if you pass it.
2. Otherwise `deep` when the change is high risk (see [Risk tiers](#risk-tiers)).
3. Otherwise `[review] effort` (default `standard`).

Each reviewer agent may run for `[review] timeout_seconds` (default 600).

## Findings

Each finding has an id (`f1`, `f2`, and so on), a file and line, a title, the evidence, and sometimes a bug class so you can fix every instance.

Severities:

- **Important**: a real problem in this change. Only Important findings hold the gate.
- **Nit**: optional. At most 3 per round are kept.
- **Pre-existing**: a problem not caused by this branch. Optional.

Categories are bug, security, behavior, test, style and other. Style findings are dropped, since style is the linters' job. Duplicates are merged, and a finding from an earlier round is not repeated.

## Rounds

Every run of `cagr review` is a round. Round 1 reviews the whole branch. After that, if the last good round's commit is an ancestor of the current one, the next round sees only the new commits and the open findings. It marks the findings that were fixed and does not repeat itself. After a rebase, the next round reviews the whole branch again.

A round that could not run is recorded with its error and does not count toward the round number.

After `[review] max_rounds` rounds (default 3), the report and the gate add: "Step back: if findings keep coming, the approach may be wrong. Rethink it, or answer the findings and let a person decide."

The record for each branch lives in `<git common dir>/cagr/reviews/<branch>.json`, so every worktree of the repo shares it. Nothing is written to the working tree.

## Answers

A finding that is wrong, intentional or minor gets an answer instead of a fix:

```sh
cagr review answer f2 --wrong "the list is never empty here: parseDeals returns at least one row"
cagr review answer f3 --intentional "we keep the old field until the mobile app ships"
cagr review answer f4 --minor "the log line only runs in dev"
```

- The reason must be a sentence a person can check, at least 8 characters.
- Any finding can be answered. An answered finding no longer holds the gate.
- A person reads every answer. `cagr review status` shows them.

`cagr review status` lists the branch's rounds and its open, answered and fixed findings, with each answer.

## Stats

`cagr review stats` reads the records of every branch and prints:

- how many branches were reviewed and how many passed;
- the mean rounds to pass, the share that passed in one round, and the share that took five or more;
- how many findings there were, how many were fixed, and how many were answered of each kind;
- the noise: "Noise: X% of findings were answered as wrong."

A high noise rate means the reviewer flags things that are not problems. Tell it what to skip in `REVIEW.md`.

## Evals

Evals measure the reviewer on past changes with a known answer, so a change to `REVIEW.md`, the model or the effort can be measured instead of guessed.

Put one TOML file per case in `.cagr/review-evals/`:

```toml
# .cagr/review-evals/null-deal.toml
name = "null-deal"          # optional, defaults to the file name
base = "a1b2c3d"            # the commit before the change
head = "e4f5a6b"            # the commit with the bug

[[expect]]
file = "src/deals.ts"       # where the bug is
line = 42                   # optional
```

For a change with no bug, use `clean = true` instead of `[[expect]]` entries. A case must have one or the other.

```sh
cagr review eval                  # run every case
cagr review eval --case null-deal # run one case
cagr review eval --effort deep    # run with another effort
```

Each case is checked out in a temporary worktree under `.git/cagr/eval-trees/` and reviewed in full. An expected bug counts as found when an Important finding lands in its file, within 10 lines of its line (or anywhere in the file if no line is given). Any other Important finding is a false positive.

```
PASS  null-deal: found 1/1, 0 false positives
MISS  auth-redirect: found 0/1, 1 false positive

Recall 50%, false positives 1.
Last run: recall 100%, false positives 0. A drop after a REVIEW.md or model change means the change made the reviewer worse.
```

A run of every case is saved to `.git/cagr/evals/last.json` and compared with the next one. A run with `--case` is not saved. The command exits 2 if any case had an error.

## Scanning existing code

`--scan` reviews existing files instead of a branch's commits, for example code that was written before cagr:

```sh
cagr review --scan 'src/billing/**' 'src/auth/**'
cagr review --scan 'src/**' --issue
```

A scan reviews the tracked files that match the globs. It does not need a clean tree, does not write a record and does not count as a round. It exits 1 if it found any Important finding. With `--issue`, it opens a GitHub issue with the findings through `gh`, titled "cagr scan: N findings in <globs>". The [nightly CI job](ci.md#the-workflow) uses this.

## The reviewer

`[review] reviewer` picks the agent:

- `"auto"` (the default): Claude Code if you are running inside Claude Code and `claude` is installed, then Codex if you are running inside Codex, then whichever of `claude` and `codex` is installed. If neither is found, the round is recorded as an error ("no reviewer agent found ...") and the review [fails open](#fail-open).
- `"claude"`: `claude -p` in read-only mode. It may only use Read, Grep and Glob, and loads no project settings, MCP servers or hooks.
- `"codex"`: `codex exec --sandbox read-only` with hooks turned off.
- A command: any other string runs as a shell command. `{prompt_file}` becomes the path of the prompt, which is also sent on stdin, and `{schema_file}` the path of the JSON schema its output must match. It must print that JSON.

`[review] model` passes a model to `claude` (`--model`) or `codex` (`-m`).

## REVIEW.md

`[review] guide` (default `REVIEW.md`) is read into every review. It is where you say what matters in this repo and what does not. A missing file is fine. `cagr init` writes a starter when review is on and the file does not exist:

```markdown
# Review guide

`cagr review` reads this file into every review. Say what matters in this repo and what does not.

## Always check

- Errors are handled where they happen, or passed up with context. Nothing fails silently.
- New behavior has a test that would fail if the code broke.
- Inputs from users, files and the network are checked before use.

## Important here

<!-- The places where a bug costs the most: money, auth, data loss, migrations. -->

## Skip

<!-- Generated code, vendored code, snapshots. Style is left to the linters. -->
```

After you change it, run `cagr review eval` to see whether the reviewer got better or worse.

## The PR gate

With `[review] enabled = true`:

- [review-gate](guards.md#review-gate) denies the `[review] gate` commands (by default `gh pr create` and `gh pr ready`) until the current commit has passed.
- [pr-body](guards.md#pr-body) denies `gh pr create` when the body lacks a `[review] pr_sections` heading.
- [agent-approval](guards.md#agent-approval) denies resolving review threads, and with `agents_may_merge = false` also merging and approving.

The gate sees `gh` commands only. A pull request opened in the browser or through another client gets past it. Branch protection and the [CI review job](ci.md) close that gap.

## Risk tiers

The risk tier of a change is set by the files it touches, not by its author:

- Each file takes the highest tier of the `[[risk.paths]]` entries it matches, or `[risk] default` (medium) if none match.
- The change takes the highest tier of its files. An empty change is low.

| Tier     | Human approvals | Review effort                      |
| -------- | --------------- | ---------------------------------- |
| `low`    | 0               | `[review] effort`                  |
| `medium` | 1               | `[review] effort`                  |
| `high`   | 2               | `deep`, unless `--effort` is given |

```toml
[[risk.paths]]
glob = "src/auth/**"
tier = "high"
owners = ["@org/security"]
reason = "Sign-in and sessions."
```

`cagr risk` shows the tier of the branch's change (against `--base`, else the protected branch, else `main`), or of files you name:

```
$ cagr risk src/a.ts README.md .github/workflows/x.yml
Risk: high. Needs 2 human approvals.
Why: CI workflows run with the repo's secrets.
high (1): .github/workflows/x.yml
medium (1): src/a.ts
low (1): README.md
```

It also lists the owners of the files. cagr does not enforce the approval counts. Set them in branch protection, and use `owners` to write CODEOWNERS (see [CI](ci.md)). `cagr ci` reports the tier in the job summary.

## Fail-open

When the reviewer cannot run (not installed, a timeout, bad output), the round is recorded as an error, `cagr review` prints the error and exits 2, and:

- If no finding is open, the gate lets the pull request through and tells the human: "cagr: the review of ... could not run (...), so this pull request goes out unreviewed. Review it yourself before you approve it."
- If findings from an earlier round are still open, the gate still denies.

So a broken reviewer never blocks work, and never hides findings that were already there.
