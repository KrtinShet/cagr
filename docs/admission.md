---
title: Machine admission
nav_order: 13
---

# Machine admission

cagr shares one memory pool across the repos and worktrees using the same local home directory on macOS and Linux. It starts medium and heavy commands when the machine has enough free tokens and memory pressure is normal. On Windows, cagr leaves agent commands unchanged and `cagr run` executes them directly.

## Classes and the wrapper

- **Light** runs immediately. Examples include lint and a single test file such as `bun test src/run.test.ts`.
- **Medium** needs tokens. Examples include `tsc`, `bun run check-types`, and a package's test suite.
- **Heavy** needs tokens and can get a Linux memory ceiling. Examples include `bun run verify`, e2e, and `docker compose up`.

The `[admission]` lists match command prefixes after cagr parses shell words, skips comments, redirections and leading assignments, and normalizes the program name. An explicit `light` match wins, then `heavy`, then `medium`. For package managers, cagr skips options before the script name and checks the `package.json` script when its name has no matching prefix. The single-file shortcut applies to direct test commands. Unmatched commands are light. For a compound command, the wrapper uses the largest class it sees and treats more than 200 commands as heavy. Add patterns in [Configuration](configuration.md#admission).

Run medium and heavy commands in the foreground.

```sh
cagr run -- bun run verify
cagr run -- sh -c 'bun run lint && bun run check-types'
```

`run` passes its arguments to the process, so use `sh -c` when you need to wrap an entire shell expression. The child uses your stdin, stdout and stderr. cagr returns the child's exit code. Claude Code and Codex before-command hooks rewrite medium and heavy calls to use the configured cagr command automatically. The hook classifies commands without reading the pool.

The queue lists the position and the PIDs, repos, branches, commands and entry times of the waiters ahead. It serves lease priority first, then push priority, then normal, with first come, first served within each priority. Set `CAGR_PRIORITY=lease` for the process holding the landing lease or `CAGR_PRIORITY=push` for push-related work. The pre-push hook uses push priority and honors lease priority when supplied. The environment variable conveys priority and lease ownership comes from the caller.

## Tokens and measurement

One token covers one GiB of peak memory, rounded up to the next whole token. cagr keeps one OS lock per held token in `~/.cache/cagr/slots`. The OS releases a lock when its last holder closes it or dies. A watchdog stops the admitted process group if its wrapper dies. Each ticket also holds an ownership lock, so a waiter or doctor can clear stale tickets even if the system has reused their PIDs.

The wrapper passes the reservation to nested `cagr run` calls and to pre-push, turn-end and CI checks. They share the outer process group and reservation. After the main command exits, cagr gives processes in that group up to 10 seconds to exit, within any remaining run deadline. It then kills any remaining members before releasing the tokens. A process that creates its own session can outlive this cleanup, so keep token-managed work in the original process group.

Before calibration, the pool has at most two tokens and at most half the machine's RAM, with a one-token minimum. Unmeasured medium and heavy commands reserve the entire effective pool. `pool_tokens` can reduce the pool size for a repo. A measured command larger than the effective pool reports the mismatch immediately.

Run a representative command when the machine is quiet.

```sh
cagr measure -- bun run verify
```

`measure` runs the command once, with the whole pool reserved for medium and heavy commands. Run it outside an existing reservation. It records the peak after a successful run in `~/.cache/cagr/costs.json`, keyed by machine, normalized origin URL and matched pattern. Repositories without an origin use the main checkout path. Worktrees and local CI scratch checkouts of the same origin share measurements. For compound expressions, measure the same expression you will run. The cache also records total RAM and the usable pool from the pre-run available-memory reading, with a two-GiB reserve and a one-token floor. Measure again if the workload, background load, or Docker Desktop allocation changes. Use `cagr doctor` to see the usable pool, held tokens, queue, pressure and measured costs.

## Pressure by platform

- **macOS** uses libc `flock(2)` through Bun FFI. The pressure reader uses `kern.memorystatus_vm_pressure_level` (1 normal, 2 warning, 4 critical) and growth between `vm.swapusage` samples. `measure` uses reclaimable memory from `vm_stat` and caps the total budget after subtracting the memory of a running Docker Desktop VM, queried from its local daemon. macOS enforces concurrency with tokens.
- **Linux** uses util-linux `flock`. It holds admission above PSI `some avg10=10` or `full avg10=1`, or when `MemAvailable` is below the requested tokens. With user scopes on systemd 254 or later, a heavy command runs with `MemoryMax=<tokens>G` and OOM kills stop the whole scope. A measurement runs uncapped. cagr disables systemd argument expansion and logs when user scopes are unavailable. Measurement prefers cgroup v2 `memory.peak` when readable and otherwise samples process-tree RSS, which macOS also uses.

Both readers sample pressure while the command runs. A timeout or SIGKILL that saw elevated pressure is **load-tainted**. cagr logs a retry and requeues it once with its original priority and a new ticket, or retries a light command immediately. An ordinary nonzero exit is returned unchanged. After a second load-tainted result, the wrapper exits 75 and asks you to rerun when the machine is quieter. CI reports a deferred check.

Each queue wait is limited to 60 seconds. Pre-push refuses the push if admission expires and asks you to retry. The turn-end hook shares a shorter deadline when needed between waiting and execution. If admission cannot start within that window, the hook reports `load: turn-end checks deferred` and allows the turn to finish if the other checks pass.

If admission setup fails before a wrapper starts the command, `cagr run` reports the error and executes directly. If the command already started, cagr reports the error without starting another copy.

See [limits and troubleshooting](limits.md#memory-admission).
