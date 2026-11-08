# Roadmap

## Not in v0.1, on purpose

Do not build these into v0.1. Each one needs its own design first.

- **Ratchets and baselines**: letting existing findings stay while blocking new ones.
- **Git-URL presets** (`extends = ["github:org/preset@v1"]`): planned for v0.2, see below.
- **GitLab**: `guardwright ci` writes GitHub annotations only, and `review --ci` posts to GitHub only.
- **`guardwright map`**: a generated map of the repo for agents.
- **`guardwright audit`**: a report of which guards fire, how often, and for whom.
- **Miss log**: recording slips the guards did not catch, to find new rules.
- **MCP server**: exposing the checks as tools the agent calls.
- **More agents**: Cursor, Gemini CLI, OpenCode, Aider and others. Until then, the git hooks cover them.

From gerb-crm, `stack clean` (removing finished worktrees) was left out: it is tied to that repo's workflow. Blocking agent merges is now built in, as part of the review pipeline in [NORTHSTAR.md](NORTHSTAR.md).

## v0.2: presets from git URLs

The loader already resolves `extends` through a list of resolvers (`src/config/presets.ts`). v0.1 has one, for the built-in presets. A git-URL resolver plugs in next to it:

- `guardwright sync` fetches each preset at its pinned ref into `~/.cache/guardwright/presets/<url-hash>/<ref>/` and writes the resolved commit to a lock file in the repo.
- Hooks read only the cache and never touch the network, so the time budgets still hold. A missing cache entry is a config error that says to run `guardwright sync`.
- Presets merge the same way as `recommended`: lists of tables add, other values replace, and the repo's own config wins.

## Build findings

**ast-grep napi embeds in a compiled Bun binary.** `@ast-grep/napi` 0.51.1 works inside `bun build --compile` on every target we tried. Cross builds need every platform's napi package in `node_modules`, which `bun install --os=* --cpu=*` installs (in Bun's `$` shell, pass the flags as interpolated strings, or the `*` is globbed).

**Python, Go and Rust parsers are embedded files.** The napi build has TypeScript, TSX, JavaScript, HTML and CSS built in. The other languages load through `registerDynamicLanguage` from the `parser.so` files in `@ast-grep/lang-*`. The build embeds the right file per target (`import ... with { type: "file" }`), and at runtime the binary writes it to `~/.cache/guardwright/<version>/` once and loads it from there.

**Verified:**

| Target                           | Where                  | Result                                                                                                                                   |
| -------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| darwin-arm64                     | macOS, no node_modules | Works, including a Python rule. Warm `command.before`: 10 to 30ms. The first run of a new binary takes about 1.8s while macOS checks it. |
| linux-arm64, linux-x64           | Debian in Docker       | Works.                                                                                                                                   |
| linux-arm64-musl, linux-x64-musl | Alpine in Docker       | Works after `apk add libstdc++ libgcc`, which Bun needs. Without them: "Error relocating ... symbol not found".                          |
| darwin-x64                       |                        | Built, not run.                                                                                                                          |
| windows-x64                      |                        | Built, not run. Loading the embedded parser file as a DLL is not verified.                                                               |

**x64 targets use Bun's baseline build.** The default x64 build warned "CPU lacks AVX support" in Docker on Apple silicon. Baseline runs on CPUs without AVX2 too, at a small speed cost.

**Binary sizes (v0.1.0):**

| Binary           | Size     |
| ---------------- | -------- |
| darwin-arm64     | 66.9 MB  |
| darwin-x64       | 71.8 MB  |
| linux-x64        | 114.9 MB |
| linux-arm64      | 112.1 MB |
| linux-x64-musl   | 107.7 MB |
| linux-arm64-musl | 105.6 MB |
| windows-x64      | 117.9 MB |

Most of this is the Bun runtime and the napi library. Wheels compress to 24 to 42 MB.

## Packaging

`bun run package` lays out what each channel would publish, from the binaries in `dist/`. Nothing is published.

- `dist/npm/`: the `guardwright` package (a Node shim that picks the binary) and one `@guardwright/cli-<os>-<arch>[-musl]` package per platform with `os`, `cpu` and `libc` set, as Biome does.
- `dist/wheels/`: one `py3-none-<platform>` wheel per platform with the binary in `.data/scripts`, as Ruff does. Tested with `uv pip install` and `uvx --from`.
- `dist/release/`: the binaries, `SHA256SUMS` and `install.sh`, for a GitHub release. `install.sh` picks the binary by OS, CPU and libc, and checks its checksum.
