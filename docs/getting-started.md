# Getting started

## Install

cagr ships as one compiled binary for macOS (arm64, x64), Linux (x64, arm64, glibc and musl) and Windows (x64).

With the install script, from GitHub releases:

```sh
curl -fsSL https://github.com/krtinshet/cagr/releases/latest/download/install.sh | sh
```

The script picks the binary for your system, checks it against the release's `SHA256SUMS`, and puts it in `~/.local/bin`. If that folder is not on your `PATH`, it tells you to add it. You can set these variables before `sh`:

| Variable            | Default          | Meaning                                                                           |
| ------------------- | ---------------- | --------------------------------------------------------------------------------- |
| `CAGR_VERSION`      | `latest`         | The release to install, such as `0.1.0` (without the `v`).                        |
| `CAGR_INSTALL_DIR`  | `~/.local/bin`   | Where the binary goes.                                                            |
| `CAGR_REPO`         | `krtinshet/cagr` | The GitHub repo to download from.                                                 |
| `CAGR_DOWNLOAD_URL` | the release URL  | A base URL that holds the binaries and `SHA256SUMS`, used instead of the release. |

On Windows the script stops with a note. Download `cagr-windows-x64.exe` from the release page instead.

With a package manager, as a dev dependency:

```sh
bun add -d cagr
# or
npm i -D cagr
```

The `cagr` package is a small wrapper. It pulls in the binary for your system as an optional package named `cagr-<os>-<arch>`, or `cagr-linux-<arch>-musl` on musl. If you installed with `--no-optional` (or your package manager skipped optional packages), the wrapper cannot find the binary and says so. Reinstall without `--no-optional`, or use the install script.

### Alpine and other musl systems

The binary needs `libstdc++` and `libgcc`. Install them first:

```sh
apk add libstdc++ libgcc
```

The install script detects musl and prints this command.

### Make sure the hooks can find cagr

The generated hook files call `cagr` by name, so it must be on `PATH` when your agent runs. A dev dependency lives in `node_modules/.bin`, which is often not on `PATH`. In that case, set `[agents] command` to a path the hooks can run and run `cagr sync`:

```toml
[agents]
command = "{root}/node_modules/.bin/cagr"
```

`{root}` becomes the repo root for each agent. `cagr doctor` tells you when the program is not on `PATH`.

## Set up a repo

```sh
cd your-repo
cagr init      # detects your stacks, writes cagr.toml and the hook files
cagr doctor    # checks the wiring, the tools, and how long each hook takes
```

### What `cagr init` detects

- **Stacks.** It looks at the repo and at project folders up to three levels deep, skipping folders like `node_modules`. Each project becomes a `[[stack]]` entry with its `paths`.
- **JavaScript and TypeScript.** The package manager comes from `packageManager` in `package.json`, or from the lockfile. Biome, ESLint and Prettier become `on_edit` commands. The `lint` and `typecheck` scripts (or `tsc`) become `on_turn_end` commands. A `verify` script becomes `git.pre_push`.
- **Python.** The package manager is uv, Poetry, Pipenv or pip. Ruff becomes an `on_edit` command. mypy and pytest become `on_turn_end` commands.
- **Agents.** Claude Code if there is a `.claude` folder or a `CLAUDE.md`, or `claude` is on `PATH`. Codex if there is a `.codex` folder or an `AGENTS.md`, or `codex` is on `PATH`. If it finds neither, it sets up both.
- **Protected branch.** From `origin/HEAD`. Otherwise `main`, or `master` if you are on `master`.

The config it writes starts with `extends = ["recommended"]`. See [Configuration](configuration.md#presets) for what that turns on.

`cagr init --dry-run` prints the config it would write and writes nothing. If `cagr.toml` already exists, `init` stops. Use `--force` to overwrite it.

### What `cagr init` writes

| File                                                                                   | What it is                                                                          | Commit it? |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------- |
| `cagr.toml`                                                                            | The config.                                                                         | Yes        |
| `.claude/settings.json`                                                                | Claude Code hooks (only if Claude Code is enabled).                                 | Yes        |
| `.codex/hooks.json`                                                                    | Codex hooks (only if Codex is enabled).                                             | Yes        |
| `.githooks/commit-msg`, `.githooks/pre-push`                                           | Git hooks.                                                                          | Yes        |
| `REVIEW.md`                                                                            | A starter review guide, written only when review is on and the file does not exist. | Yes        |
| `.github/workflows/cagr.yml`, `.github/pull_request_template.md`, `.github/CODEOWNERS` | Only when `[ci] github = true`. See [CI](ci.md).                                    | Yes        |

Then it runs your `on_edit` commands on the JSON files it wrote, so your formatter is happy with them, and sets `git config core.hooksPath .githooks`. If the folder is not a git repo, it writes the git hooks but does not set `core.hooksPath`. Run `cagr install-git-hooks` after `git init`.

Commit all of these files. Every teammate and every agent then gets the same guardrails. A teammate who does not have cagr installed can still commit and push: the git hooks print a warning and let the call through.

If you already have hooks of your own in `.claude/settings.json` or `.codex/hooks.json`, `init` and `sync` keep them and only manage cagr's entries.

### Trust the hooks in Codex

Codex asks you to trust project hooks once. Open Codex in the repo and approve them with `/hooks`. Until you do, Codex does not run them. `cagr init` prints this reminder when Codex is enabled.

## Check the setup

`cagr doctor` prints one line per check, in these sections:

- **Config**: the config and the code rules load.
- **Wiring**: the generated files match the config, `core.hooksPath` points at the hooks folder, and the hooks are executable.
- **Tools**: `cagr` is on `PATH`, and the program in every `on_edit`, `on_turn_end` and `pre_push` command can be found (including in `node_modules/.bin` and `.venv/bin`).
- **Review** (when review is on): a reviewer agent is installed, and the guide and gate are set.
- **Timing**: the measured time of each hook against its [budget](hooks-and-events.md#time-budgets).

`cagr doctor --github` also checks the branch protection on GitHub. See [CI](ci.md#check-branch-protection).

Each failing line says what to fix.

## Next steps

- Read the brief your agent gets at the start of each session: it lists the rules in plain words.
- Change `cagr.toml`, then run `cagr sync`. See [Configuration](configuration.md).
- Add code rules in `.cagr/rules/`. See [Code rules](code-rules.md).
- Fill in `REVIEW.md`. See [Review](review.md).
