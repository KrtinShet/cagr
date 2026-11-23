# Serial leases

Independent branches can prepare migrations or protocol changes in parallel. At landing, one branch at a time needs to merge the protected branch and choose the next number.

Declare each resource in `.cagr/serial.toml`.

```toml
[[lease]]
name = "db-migrations"
paths = ["packages/db/migrations/**", "packages/db/src/schema/**"]
after_acquire = "Merge origin/main, then run pnpm --filter @inder/db generate."
ttl_seconds = 1800
```

1. Develop and run targeted tests on your branch. The edit hook gives one notice per session for each resource.
2. Run `cagr lease take db-migrations` at landing time. If someone holds it, you'll get a place in line and exit code 1. Use `--wait` to stay in the foreground and renew your ticket while waiting. You can keep working in another terminal.
3. Fetch and merge the latest protected branch, regenerate the migration or version, then verify, push to the same branch name on origin and open or update your PR. Take every lease your push needs. If a change needs multiple leases, take them in name order.
4. Hold the lease until the PR lands. Run `cagr lease renew db-migrations` if it still needs to wait. The pre-push hook renews while it runs verification with `CAGR_PRIORITY=lease`.
5. Run `cagr lease release db-migrations` from the holder branch when done. The hook releases on a refusal or failed verification. If Git rejects the push after the hook completes, release manually or fix the error and retry before the lease expires.

`cagr lease list` shows the holder, age, last renewal and waiting branches. Leases and tickets expire after `ttl_seconds` without renewal, 30 minutes by default. The earliest live ticket gets the next turn. This order uses client timestamps, so keep the builders' clocks synchronized.

A taker can reclaim an expired lease, a lease whose published branch has been deleted, or a lease whose pushed tip is an ancestor of the protected branch. Release explicitly after a squash or rebase merge if the original tip is absent from the protected branch's history. A branch that has never been observed on origin is treated as unpublished until it is observed or its tip is found in the protected branch. This preserves leases taken before a first push. The TTL also covers branches deleted remotely before any lease renewal observed them.

`cagr lease release --break db-migrations` reclaims an expired, merged or deleted holder. A person can set `CAGR_ALLOW_LEASE_BREAK=1` in their terminal to break a live lease. The command prints the actor and time and records them in `cagr/leases.log` under the local Git common directory.

Lease records live in `refs/cagr/lease/<name>` on origin. Tickets live in `refs/cagr/wait/<name>/<epoch-ms>-<encoded-branch>`. Client hooks check branch pushes against the old remote tip, or against `[git].protected_branch` on origin for new branches. When no protected branch is configured, they use origin's default branch. Install the Git hooks with `cagr sync` on each machine that pushes.
