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

export const configFileName = "guardwright.toml";

/** The nearest guardwright.toml, or pyproject.toml with [tool.guardwright], from `start` up. */
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
			if (tool.guardwright)
				return { file: pyproject, raw: tool.guardwright as RawConfig };
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

export function resolveConfig(
	raw: RawConfig,
	root: string,
	source: string,
	resolvers: PresetResolver[] = [builtinResolver],
): Config {
	validate(raw, source);
	const merged = withPresets(raw, source, resolvers, []);
	return applyDefaults(merged, root, source);
}

function validate(raw: RawConfig, source: string) {
	const errors: string[] = [];
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
export function merge(base: RawConfig, over: RawConfig): RawConfig {
	const out: RawConfig = { ...base };
	for (const [key, value] of Object.entries(over)) {
		const current = out[key];
		if (isTable(current) && isTable(value)) out[key] = merge(current, value);
		else if (isTableList(current) && isTableList(value))
			out[key] = [...current, ...value];
		else out[key] = value;
	}
	return out;
}

const isTable = (value: unknown): value is RawConfig =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isTableList = (value: unknown): value is RawConfig[] =>
	Array.isArray(value) && value.length > 0 && value.every(isTable);

function applyDefaults(raw: RawConfig, root: string, source: string): Config {
	const agents = (raw.agents ?? {}) as RawConfig;
	const git = (raw.git ?? {}) as RawConfig;
	const files = (raw.files ?? {}) as RawConfig;
	const commands = (raw.commands ?? {}) as RawConfig;
	const rules = (raw.rules ?? {}) as RawConfig;
	const review = (raw.review ?? {}) as RawConfig;
	const risk = (raw.risk ?? {}) as RawConfig;
	const ci = (raw.ci ?? {}) as RawConfig;
	const commitTypes =
		(git.commit_types as string[] | undefined) ?? defaultCommitTypes;
	const prePush = git.pre_push;
	return {
		root,
		source,
		extends: (raw.extends as string[] | undefined) ?? [],
		agents: {
			enabled: (agents.enabled as AgentName[] | undefined) ?? [
				"claude",
				"codex",
			],
			command: (agents.command as string | undefined) ?? "guardwright",
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
			skip_env: (git.skip_env as string | undefined) ?? "GUARDWRIGHT_SKIP",
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
		rules: {
			dirs: (rules.dirs as string[] | undefined) ?? [".guardwright/rules"],
		},
		review: {
			enabled: (review.enabled as boolean | undefined) ?? false,
			gate: (review.gate as string[] | undefined) ?? [
				"gh pr create",
				"gh pr ready",
			],
			reviewer: (review.reviewer as string | undefined) ?? "auto",
			model: (review.model as string | undefined) ?? null,
			guide: (review.guide as string | undefined) ?? "REVIEW.md",
			effort: (review.effort as Effort | undefined) ?? "standard",
			security: (review.security as boolean | undefined) ?? true,
			max_rounds: (review.max_rounds as number | undefined) ?? 3,
			timeout_seconds: (review.timeout_seconds as number | undefined) ?? 600,
			skip: (review.skip as string[] | undefined) ?? [],
			pr_sections: (review.pr_sections as string[] | undefined) ?? [],
			agents_may_merge:
				(review.agents_may_merge as boolean | undefined) ?? true,
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
				"curl -fsSL https://github.com/guardwright/guardwright/releases/latest/download/install.sh | sh",
		},
		brief: (raw.brief as string[] | undefined) ?? [],
	};
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
