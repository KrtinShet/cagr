---
title: Review
nav_order: 9
---

# Review

`cagr review` reviews the branch against its base with a reviewer agent: Claude Code or Codex, started read-only in a fresh context, with its own hooks turned off. It reads the review guide, `.cagr/review.md` (what matters in this repo), the diff, the commit messages and the risk tier, and it can read any other file in the repo that it needs.

With review on, the [review gate](guards.md#review-gate) denies `gh pr create` and `gh pr ready` until the current commit has passed a review. The loop for an agent is:

1. Commit.
2. Run `cagr review`. It takes a few minutes, so give the command a 15 minute timeout.
3. Fix each Important finding and commit, or [answer](#answers) it.
4. If you made another commit, run `cagr review` again to check it.
5. Push once the review passes, then open the pull request.

The `recommended` preset turns review on. Without a preset, set `[review] enabled = true`.

## Running a review

```sh
cagr review                      # review the branch's commits since its base
cagr review --base develop       # compare with another base branch
cagr review --full               # force a full round of the whole branch
cagr review --effort deep        # pick the effort for this run
```

Before it starts:

- Tracked files must be committed. If not: "Commit your changes first. The review covers commits, and the gate checks the commit you open the pull request from."
- The base is `--base`, else `[git] protected_branch`, else `main`. cagr uses `origin/<base>` if it exists, else the local `<base>`. If it finds neither: "Cannot find the base branch "develop". Fetch it, or pass --base <branch>."
- If the branch has no commits beyond the base, there is nothing to review.
- While rounds remain, if the current commit was already reviewed, it says so and does not run again, unless an Important finding from an earlier round is still open there and has not been rechecked at this commit (the verifier looks once more), or you pass `--full`.

The diff leaves out files that match `[review] skip`. A diff over 150,000 characters is cut, with a note and a `--stat` summary. The reviewer gets the commit subjects and bodies for the range, without merge commits, cut at 6,000 characters.

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

When no Important finding is open, the report says the review passed and the branch is ready to push.

Exit codes: 0 passed, 1 Important findings open, 2 error (including a reviewer that could not run, and bad arguments).

With `[review] status = true`, `cagr review` and `cagr review answer` also set the GitHub commit status `cagr/review` on HEAD: `success` when the gate passes, `failure` with the count of open Important findings. A note on stderr says whether it was sent. The exit code does not change. See [Commit statuses without a workflow](ci.md#commit-statuses-without-a-workflow).

## Effort

Effort sets how many agents look at the change.

| Effort     | Finders                                               | Verifiers                                          |
| ---------- | ----------------------------------------------------- | -------------------------------------------------- |
| `quick`    | one bug finder                                        | one for earlier findings, when there are any      |
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

Commit the change, run `cagr review` locally, fix Important findings in one commit or answer them, and re-check while rounds remain. Push once every Important finding is verified fixed or answered. Before reviewing, add a test that fails without each new behavior or bug fix. Put intent and deliberate trade-offs in the commit body. Fix every instance of each reported bug class and run targeted tests before the next review.

1. The first round reviews the whole branch.
2. Later rounds run finders on the new commits and a verifier on earlier findings. A verifier-only recheck also uses a round.

`[review] max_rounds` defaults to 3 completed rounds per branch. Failed reviewer runs do not count. A rebase, a reused branch name, or `cagr review --full` can start a new full review while rounds remain. The branch keeps its count and prior findings across those cycles.

After the cap, `cagr review` exits with code 2 and lists the open Important findings. Fix only findings that break the intended case. Answer findings that are wrong, intentional or minor with `cagr review answer <id> --wrong|--intentional|--minor "<why>"`. An unverified fix still leaves the finding open. A human can run `CAGR_ALLOW_EXTRA_REVIEW=1 cagr review` to spend one extra round beyond the configured limit, for example to verify a fix made after round 3. The command guard refuses attempts by agents to set the switch.

The gate passes once all Important findings are verified fixed or answered. After the cap it lets later commits through without a finder review and reports how many commits were not reviewed. A finding counts as fixed only if the verifier judged it fixed on that commit or an ancestor. A reset to before the fix can close the gate again. Answers carry across commits. Before the cap, an older reviewed head passes while none of the findings known when it was reviewed is open on it. Nits and pre-existing findings never block.

An open finding gets a new verdict only when the commits since its last verdict (or since the round that reported it) changed its file, or changed a reviewed file (one not in `[review] skip`) and one of the branch's own commits (not a merge, and not a commit from the base) names its id, such as `f1`, in its message. A verdict on unchanged code would only reroll the model, so an empty commit, or a commit for another finding, leaves it open with no model call, and `cagr review` says so: "f1 is still open: no commit since the last check touched src/deals.ts. Fix it, or answer it with `cagr review answer f1 ...`." If the fix is in another file (a new test, a check in a caller), name the finding in the commit message, for example `fix(deals): check the session in the caller (f1)`. The check is on the whole file, not the finding's lines, since lines move between commits. A finding with no file is judged again after any reviewed change. A diff round with an empty diff runs no finders either.

An open finding gets at most 3 verdicts on the branch, counting rechecks, so many small edits cannot reroll it forever. The count does not reset with a new cycle, so `--full` and rebases cannot reset it either. Past that, `cagr review` does not judge it again: "f1 is still open: the verifier judged it 3 times, the most it may." Answer it. Verdicts on fixed findings (rechecks of a fix) do not count, and a finding the verifier reopens starts its count again, since it needs a new fix.

If rounds remain and you think the verifier was wrong about an earlier finding, run `cagr review` again at the same commit: it runs the verifier once more on the findings from earlier rounds. That recheck runs once per finding per commit. After it, `cagr review` at that commit does nothing and says to commit a fix or answer the finding (`cagr review answer <id> --wrong "<why>"`). `--full` still runs a full round there, but the verifier does not judge a finding a third time at the same commit, and never judges a finding at the commit that reported it. A finding reported at this commit needs a fix or an answer.

With `[review] status = true`, the pre-push hook and `cagr review answer` send `cagr/review` for the commit:

- `success` when no Important finding is open and the commit was reviewed or the branch is at the cap;
- `success` with "Unreviewed: the reviewer failed" when the reviewer could not run and no Important finding is open, so a required status fails open;
- `failure` when an Important finding is open at a reviewed commit or the branch is at the cap;
- `pending` when it has not been reviewed yet and rounds remain.

For commits after the cap, the local gate, commit status and CI review report use a message such as “Reviewed through round 3; 2 later commits were not reviewed.”

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
- the share of later-round findings on fix lines;
- how many findings there were, how many were fixed, and how many were answered of each kind;
- the noise: "Noise: X% of findings were answered as wrong."

A fix line is a line added or replaced in the net diff from the first full review to the round that reported the finding. The share uses findings from later diff rounds with a file, a positive line number and both commits available locally. A line without a matching change counts as earlier code.

A high noise rate means the reviewer flags things that are not problems. Tell it what to skip in the review guide.

## Evals

Evals measure the reviewer on past changes with a known answer, so a change to the review guide, the model or the effort can be measured instead of guessed.

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

## The review guide

`[review] guide` is read into every review. It defaults to `.cagr/review.md`, or to `REVIEW.md` when only that file exists. It is where you say what matters in this repo and what does not. A missing file is fine. `cagr init` writes a starter `.cagr/review.md` when review is on and no guide exists:

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
- If findings from an earlier round are still open, the gate still denies. So does a finding fixed on a commit the head does not contain when the fix's files (those its fix round covered, and the finding's own) differ at the head, for example after `git reset` to before the fix.
- A finding fixed on history that a rebase replaced, whose fix's files the rebase left as the fix had them, does not hold the gate: the failed round would only have checked it again.

So a broken reviewer never blocks work, and never hides findings that were already there.
