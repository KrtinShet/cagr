These are captured outputs, not invented tool schemas. Paths are normalized to `/fixture`.

- ESLint 9.39.5: `eslint --format json --stdin --stdin-filename sample.js`, with `no-undef: error` in a flat config.
- Ruff 0.15.9: `ruff check --output-format json --stdin-filename sample.py -`.
- Biome 2.6.6: `biome lint --reporter=json sample.js` and the corresponding stdin call. The stdin capture proves that file-based comparison is required. The biome-baseline, inserted, added, replaced and edited reports were captured from the repo-local Biome 2.6.6 with only suspicious/noDebugger enabled.

The adjacent text files contain the exact source for each ESLint and Ruff report. Cases cover inserted lines, an added violation, replacing an old violation, and editing the old diagnostic line.
