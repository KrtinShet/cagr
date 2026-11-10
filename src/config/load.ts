import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	builtinResolver,
	type PresetResolver,
	type RawConfig,
} from "./presets";
import {
	type AgentName,
	type Config,
	configSchema,
	defaultCommitTypes,
	defaultExtensions,
	type Effort,
	type NameRule,
	type PackageManager,
	type RiskTier,
} from "./schema";

export class ConfigError extends Error {}

export const configFileName = "cagr.toml";

/** The nearest cagr.toml, or pyproject.toml with [tool.cagr], from `start` up. */
export function findConfig(
	start: string,
): { file: string; raw: RawConfig } | null {
	let dir = start;
	for (;;) {
		const toml = join(dir, configFileName);
		if (existsSync(toml)) return { file: toml, raw: parseToml(toml) };
		const pyproject = join(dir, "pyproject.toml");
		if (existsSync(pyproject)) {
			const tool = (parseToml(pyproject).tool ?? {}) as RawConfig;
			if (tool.cagr) return { file: pyproject, raw: tool.cagr as RawConfig };
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function parseToml(file: string): RawConfig {
	try {
		return Bun.TOML.parse(readFileSync(file, "utf8")) as RawConfig;
	} catch (error) {
		const where = error as { line?: number; column?: number };
		throw new ConfigError(
			`${file}:${(where.line ?? 0) + 1}:${(where.column ?? 0) + 1}: not valid TOML (${String(error)}).`,
		);
	}
}

export function loadConfig(
	start: string,
	resolvers: PresetResolver[] = [builtinResolver],
): Config | null {
	const found = findConfig(start);
	if (!found) return null;
	return resolveConfig(found.raw, dirname(found.file), found.file, resolvers);
}

/** The folder of config fragments and rules, at the repo root. */
export const fragmentDir = ".cagr";

/** Folders in `.cagr/` that hold TOML of another kind, not config. */
const notConfig = ["review-evals/"];

/** Every TOML file in `.cagr/` under `root`, at any depth, sorted, except the review evals. */
export function fragmentFiles(root: string): string[] {
	const dir = join(root, fragmentDir);
	if (!existsSync(dir)) return [];
	return [...new Bun.Glob("**/*.toml").scanSync({ cwd: dir })]
		.filter((file) => {
			const path = file.replaceAll("\\", "/");
			return !notConfig.some((folder) => path.startsWith(folder));
		})
		.map((file) => join(dir, file))
		.sort();
}

export function resolveConfig(
	raw: RawConfig,
	root: string,
	source: string,
	resolvers: PresetResolver[] = [builtinResolver],
): Config {
	validate(raw, source);
	const { combined, sources } = withFragments(raw, root, source);
	const merged = withPresets(combined, source, resolvers, []);
	return applyDefaults(merged, root, source, sources);
}

/**
 * Adds each TOML file in `.cagr/` to the config, in sorted order. Lists of tables
 * add up, as with presets. Any other value may be set in one file only, so
 * there is no question which one wins.
 */
function withFragments(
	raw: RawConfig,
	root: string,
	source: string,
): { combined: RawConfig; sources: string[] } {
	const files = fragmentFiles(root);
	const owners = new Map<string, Owner>();
	const errors: string[] = [];
	claim(raw, source, "", owners, errors);
	let combined = raw;
	for (const file of files) {
		const { $schema: _, ...fragment } = parseToml(file);
		validate(fragment, file);
		if (fragment.extends !== undefined)
			errors.push(
				`${file} sets extends. Presets are chosen in ${source} only: move it there.`,
			);
		claim(fragment, file, "", owners, errors);
		combined = merge(combined, fragment);
	}
	if (errors.length > 0)
		throw new ConfigError(
			`The config files disagree:\n${errors.map((error) => `  - ${error}`).join("\n")}`,
		);
	return { combined, sources: [source, ...files] };
}

/** The lists of tables that add up across files and presets, even when one is empty. */
const listsThatAddUp = new Set([
	"stack",
	"files.protected",
	"commands.blocked",
	"risk.paths",
]);

type Owner = { file: string; table: boolean };

/**
 * Records which file set each value, and reports a value two files set. A
 * table in one file and a plain value at the same key in another also clash.
 */
function claim(
	raw: RawConfig,
	file: string,
	prefix: string,
	owners: Map<string, Owner>,
	errors: string[],
) {
	const clash = (path: string, other: string) =>
		errors.push(
			`${path} is set in both ${other} and ${file}. Keep it in one of them.`,
		);
	for (const [key, value] of Object.entries(raw)) {
		if (prefix === "" && (key === "$schema" || key === "extends")) continue;
		const path = prefix === "" ? key : `${prefix}.${key}`;
		const owner = owners.get(path);
		if (isTable(value)) {
			if (owner && !owner.table) clash(path, owner.file);
			else {
				if (!owner) owners.set(path, { file, table: true });
				claim(value, file, path, owners, errors);
			}
			continue;
		}
		if (listsThatAddUp.has(path) || isTableList(value)) continue;
		if (owner) clash(path, owner.file);
		else owners.set(path, { file, table: false });
	}
}

function validate(raw: RawConfig, source: string) {
	const errors: string[] = [];
	if ("layout" in raw) {
		const { layout: _, ...rest } = raw;
		errors.push(
			"[[layout]] moved out of the config, into rule files. Put each layout rule in a .cagr/rules/*.yml file, with its files, ignores, name and allowed under a `layout:` block and example paths under `examples:`, then delete [[layout]]. See https://github.com/KrtinShet/cagr/blob/main/docs/code-rules.md#layout-rules",
		);
		raw = rest;
	}
	configSchema.check(raw, "", errors);
	if (errors.length > 0)
		throw new ConfigError(
			`${source} has problems:\n${errors.map((error) => `  - ${error}`).join("\n")}`,
		);
}

function withPresets(
	raw: RawConfig,
	source: string,
	resolvers: PresetResolver[],
	seen: string[],
): RawConfig {
	let base: RawConfig = {};
	for (const name of (raw.extends as string[] | undefined) ?? []) {
		if (seen.includes(name))
			throw new ConfigError(`${source}: extends loops through "${name}".`);
		const preset = resolvers.map((resolve) => resolve(name)).find(Boolean);
		if (!preset)
			throw new ConfigError(
				`${source}: extends names "${name}", which is not a known preset. v0.1 has "recommended"; presets from git URLs come in v0.2.`,
			);
		validate(preset, `preset "${name}"`);
		base = merge(
			base,
			withPresets(preset, `preset "${name}"`, resolvers, [...seen, name]),
		);
	}
	return merge(base, raw);
}

/** Lists of tables add to the base; every other value replaces it. */
export function merge(
	base: RawConfig,
	over: RawConfig,
	prefix = "",
): RawConfig {
	const out: RawConfig = { ...base };
	for (const [key, value] of Object.entries(over)) {
		const path = prefix === "" ? key : `${prefix}.${key}`;
		const current = out[key];
		if (isTable(current) && isTable(value))
			out[key] = merge(current, value, path);
		else if (
			Array.isArray(current) &&
			Array.isArray(value) &&
			(listsThatAddUp.has(path) || (isTableList(current) && isTableList(value)))
		)
			out[key] = [...current, ...value];
		else out[key] = value;
	}
	return out;
}

const isTable = (value: unknown): value is RawConfig =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isTableList = (value: unknown): value is RawConfig[] =>
	Array.isArray(value) && value.length > 0 && value.every(isTable);

function applyDefaults(
	raw: RawConfig,
	root: string,
	source: string,
	sources: string[],
): Config {
	const agents = (raw.agents ?? {}) as RawConfig;
	const git = (raw.git ?? {}) as RawConfig;
	const files = (raw.files ?? {}) as RawConfig;
	const commands = (raw.commands ?? {}) as RawConfig;
	const rules = (raw.rules ?? {}) as RawConfig;
	const suppressions = (raw.suppressions ?? {}) as RawConfig;
	const review = (raw.review ?? {}) as RawConfig;
	const risk = (raw.risk ?? {}) as RawConfig;
	const ci = (raw.ci ?? {}) as RawConfig;
	const commitTypes =
		(git.commit_types as string[] | undefined) ?? defaultCommitTypes;
	const prePush = git.pre_push;
	return {
		root,
		source,
		sources,
		extends: (raw.extends as string[] | undefined) ?? [],
		agents: {
			enabled: (agents.enabled as AgentName[] | undefined) ?? [
				"claude",
				"codex",
			],
			command: (agents.command as string | undefined) ?? "cagr",
			nested_docs: (agents.nested_docs as boolean | undefined) ?? false,
		},
		git: {
			protected_branch: (git.protected_branch as string | undefined) || null,
			branch_name: nameRule(git.branch_name, commitTypes),
			commit_message: nameRule(git.commit_message, commitTypes),
			commit_types: commitTypes,
			pre_push:
				typeof prePush === "string"
					? [prePush]
					: ((prePush as string[] | undefined) ?? []),
			block_force_push: (git.block_force_push as boolean | undefined) ?? false,
			block_hook_skips: (git.block_hook_skips as boolean | undefined) ?? false,
			skip_env: (git.skip_env as string | undefined) ?? "CAGR_SKIP",
			hooks_path: (git.hooks_path as string | undefined) ?? ".githooks",
			worktree_only: (git.worktree_only as boolean | undefined) ?? false,
			worktree_dir: (git.worktree_dir as string | undefined) ?? ".worktrees",
		},
		stack: ((raw.stack as RawConfig[] | undefined) ?? []).map((stack) => {
			const language = stack.language as string;
			return {
				language,
				package_manager:
					(stack.package_manager as PackageManager | undefined) ?? null,
				paths: (stack.paths as string[] | undefined) ?? ["**"],
				extensions:
					(stack.extensions as string[] | undefined) ??
					defaultExtensions[language] ??
					[],
				on_edit: (stack.on_edit as string[] | undefined) ?? [],
				on_turn_end: (stack.on_turn_end as string[] | undefined) ?? [],
			};
		}),
		files: {
			protected: ((files.protected as RawConfig[] | undefined) ?? []).map(
				(entry) => ({
					glob: entry.glob as string,
					except: (entry.except as string[] | undefined) ?? [],
					reason: entry.reason as string,
				}),
			),
		},
		commands: {
			blocked: ((commands.blocked as RawConfig[] | undefined) ?? []).map(
				(entry) => ({
					match: entry.match as string,
					reason: entry.reason as string,
				}),
			),
		},
		findings: {
			mode:
				((raw.findings as RawConfig | undefined)?.mode as
					| "all"
					| "new"
					| undefined) ?? "all",
		},
		suppressions: {
			enabled: (suppressions.enabled as boolean | undefined) ?? false,
			allow: (suppressions.allow as string[] | undefined) ?? [],
		},
		rules: {
			dirs: (rules.dirs as string[] | undefined) ?? [".cagr/rules"],
		},
		review: {
			enabled: (review.enabled as boolean | undefined) ?? false,
			gate: (review.gate as string[] | undefined) ?? [
				"gh pr create",
				"gh pr ready",
			],
			reviewer: (review.reviewer as string | undefined) ?? "auto",
			model: (review.model as string | undefined) ?? null,
			guide: (review.guide as string | undefined) ?? defaultGuide(root),
			effort: (review.effort as Effort | undefined) ?? "standard",
			security: (review.security as boolean | undefined) ?? true,
			max_rounds: (review.max_rounds as number | undefined) ?? 3,
			timeout_seconds: (review.timeout_seconds as number | undefined) ?? 600,
			skip: (review.skip as string[] | undefined) ?? [],
			pr_sections: (review.pr_sections as string[] | undefined) ?? [],
			agents_may_merge:
				(review.agents_may_merge as boolean | undefined) ?? true,
			status: (review.status as boolean | undefined) ?? false,
		},
		risk: {
			default: (risk.default as RiskTier | undefined) ?? "medium",
			paths: ((risk.paths as RawConfig[] | undefined) ?? []).map((entry) => ({
				glob: entry.glob as string,
				tier: entry.tier as RiskTier,
				owners: (entry.owners as string[] | undefined) ?? [],
				reason: (entry.reason as string | undefined) ?? null,
			})),
		},
		ci: {
			github: (ci.github as boolean | undefined) ?? false,
			review: (ci.review as boolean | undefined) ?? false,
			nightly: (ci.nightly as string[] | undefined) ?? [],
			install:
				(ci.install as string | undefined) ??
				"curl -fsSL https://github.com/krtinshet/cagr/releases/latest/download/install.sh | sh",
		},
		brief: (raw.brief as string[] | undefined) ?? [],
	};
}

/** `.cagr/review.md`, unless only a REVIEW.md exists. */
function defaultGuide(root: string) {
	const inFolder = `${fragmentDir}/review.md`;
	return !existsSync(join(root, inFolder)) &&
		existsSync(join(root, "REVIEW.md"))
		? "REVIEW.md"
		: inFolder;
}

function nameRule(value: unknown, types: string[]): NameRule | null {
	const alternatives = types.join("|");
	if (value === "type/name")
		return {
			pattern: new RegExp(`^(${alternatives})/[a-z0-9]+(-[a-z0-9]+)*$`),
			example: `${types[0] ?? "feat"}/deal-pipeline`,
			label: "<type>/<short-kebab-name>",
			hint: `Types: ${types.join(" ")}.`,
		};
	if (value === "conventional")
		return {
			pattern: new RegExp(
				`^(${alternatives})(\\([a-z0-9-]+\\))?!?: [a-z].*[^.]$`,
			),
			example: `${types[0] ?? "feat"}(deals): add pipeline board`,
			label: "<type>(<scope>): <summary>",
			maxLength: 72,
			hint: `Lowercase summary, no trailing period. Types: ${types.join(" ")}.`,
		};
	if (isTable(value)) {
		const pattern = value.pattern as string;
		try {
			return {
				pattern: new RegExp(pattern),
				example: value.example as string,
				label: pattern,
			};
		} catch {
			throw new ConfigError(
				`git: "${pattern}" is not a valid regular expression.`,
			);
		}
	}
	return null;
}
