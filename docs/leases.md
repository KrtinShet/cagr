# Serial leases

Independent branches can prepare migrations or protocol changes in parallel. At landing, one branch at a time merges the protected branch and chooses the next number.

Declare each resource in `.cagr/serial.toml`.

```toml
[[lease]]
name = "db-migrations"
paths = ["packages/db/migrations/**", "packages/db/src/schema/**"]
after_acquire = "Merge origin/main, then run pnpm --filter @inder/db generate."
ttl_seconds = 1800
```

1. Develop and run targeted tests on your branch. The edit hook gives one notice per session for each resource.
2. Run `cagr lease take db-migrations` when ready to land. If someone holds it, the command shows your place in line and exits with code 1. Use `--wait` to stay in the foreground and renew your ticket. Take every lease you need, in name order.
3. Fetch and merge the latest protected branch, then regenerate the migration or version. Push to the same branch name on origin and open or update the PR.
4. Require the CI check that runs `cagr ci`, or run `cagr ci --pr <number>` and require its `cagr/checks` status. The Leases check reads origin and requires the PR branch to hold a live lease for every leased path changed since the merge base, including deletions. With leases configured, pre-push sends review status only. Run CI for the checks status.
5. Hold the lease until the PR merges. Renew with `cagr lease renew db-migrations` before the TTL runs out while waiting. Pre-push also renews during verification, with `CAGR_PRIORITY=lease`, and `cagr ci --pr <number>` renews when run from the holder checkout. If it expires, the next CI run fails. Take the lease again, merge the protected branch, renumber and regenerate, then push.
6. Merge while the lease is live. Rerun the required check before merging if the PR has been waiting. A previously posted success is a snapshot and stays green until the check runs again. Require the branch to be up to date with the protected branch so a merge ahead of yours requires a new check. The next taker automatically clears a merged holder's lease.

The hook keeps the lease after a successful push. When a hook check fails, it keeps the lease if the branch already has leased changes on origin, and otherwise releases it. If Git rejects the push after the hook finishes, check `cagr lease list` and retry before expiry. Use `cagr lease release db-migrations` to give up your turn after closing an abandoned PR.

`cagr lease list` shows the holder, age, last renewal, time remaining and waiting branches. Leases and tickets expire after `ttl_seconds` without renewal, 30 minutes by default. Live tickets are ordered by timestamp and then full ref name. Keep the builders' clocks synchronized. Takers recheck the line before claiming a free lease. A create-only compare-and-swap on the lease ref guarantees a single winner even when takers see different snapshots.

A taker can reclaim an expired lease, an observed remote branch that was deleted, or a branch that merged into the protected branch. A squash or rebase merge is recognized through a matching merged GitHub PR when `gh` is available and signed in. If the lookup is unavailable, the lease can expire normally or the holder can release it after merging.

`cagr lease release --break db-migrations` reclaims an expired, merged or deleted holder. A person can set `CAGR_ALLOW_LEASE_BREAK=1` in their terminal to break a live lease. The command prints the actor and time and records them in `cagr/leases.log` under the local Git common directory. A taker skips, removes and reports malformed lease and ticket records. To remove just the malformed tickets, run `cagr lease release --break db-migrations --prune-tickets`.

Lease records live in `refs/cagr/lease/<name>` on origin. Tickets live in `refs/cagr/wait/<name>/<epoch-ms>-<encoded-branch>`. Client hooks compare the pushed tree to its merge base with the protected branch. They also check updates that remove an already published branch change and compare forced updates with the old remote tip. When no protected branch is configured, they use origin's default branch. Install the Git hooks with `cagr sync` on each machine that pushes.

Pre-push reads the parent Git command on macOS and Linux. It checks ownership during a dry run and leaves remote refs alone. If it cannot identify a real push, it also leaves the refs alone. Use `cagr lease renew` before pushing in an environment where the hook cannot identify the parent command.

The Leases check runs on PR heads. A GitHub merge-group checkout has no single PR head branch, and a group with leased changes fails the check. Use the PR check on an up-to-date branch for changes that need a lease.
