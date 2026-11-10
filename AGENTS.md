cagr checks what a coding agent does (its commands, edits, stops and pull requests) and makes it run and obey your linters.

# AGENTS.md

cagr: a harness for coding agents. TypeScript on Bun, shipped as one compiled binary.

## Commands

- `bun run verify`: lint, type check and tests. Run it before you finish.
- `bun run format`: fix formatting.
- `bun run build --host`: compile `dist/cagr-<os>-<arch>` for this machine. `bun run build` builds every platform.
- `bun run e2e`: run the host binary against fresh TypeScript and Python projects.
- `bun run schema`: regenerate `schema/cagr.schema.json` after changing `src/config/schema.ts`.

## Map

- `src/cli.ts`: commands.
- `src/config/`: TOML loading, presets, the schema (one definition gives validation, defaults and the JSON schema).
- `src/guards/`: pure checks on a command, a file path, a branch or a commit subject. Each returns a finding with a reason that names the fix.
- `src/hook/`: agent events. `adapters.ts` maps each agent's JSON to normalized events and back; `handlers.ts` decides.
- `src/rules/`: ast-grep code rules. `src/git-hooks.ts`, `src/sync.ts`, `src/init.ts`, `src/doctor.ts`: as named.
- `scripts/`: build, package and e2e. `packaging/`: the npm shim and the install script.

## Rules

- Use bun for everything.
- Every block message says what to do instead.
- Every new guard, rule or branch gets a test that fails when the code breaks.
- Hooks fail open: an error in cagr lets the call through and tells the human.
- Keep to the budgets: command.before < 50ms, file.after_edit < 1s, turn.end < 60s.
- Plain words. No em dashes, no emojis. Comments only for a non-obvious why.
