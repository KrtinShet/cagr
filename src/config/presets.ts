export type RawConfig = Record<string, unknown>;

/**
 * Turns a name in `extends` into a raw config, or returns undefined when it
 * does not handle that name. v0.1 has only built-in presets. Presets from git
 * URLs (v0.2) plug in as another resolver that reads a local cache filled by
 * `cagr sync`, so hooks never touch the network.
 */
export type PresetResolver = (name: string) => RawConfig | undefined;

const lockfiles = [
	"bun.lock",
	"bun.lockb",
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"uv.lock",
	"poetry.lock",
	"Pipfile.lock",
	"Cargo.lock",
	"go.sum",
];

export const builtinPresets: Record<string, RawConfig> = {
	recommended: {
		suppressions: { enabled: true },
		git: {
			protected_branch: "main",
			branch_name: "type/name",
			commit_message: "conventional",
			block_force_push: true,
			block_hook_skips: true,
		},
		review: {
			enabled: true,
			pr_sections: ["Testing", "Risk", "How to revert"],
			agents_may_merge: false,
		},
		risk: {
			paths: [
				{
					glob: ".github/workflows/**",
					tier: "high",
					reason: "CI workflows run with the repo's secrets.",
				},
				{
					glob: "{**/*.md,docs/**}",
					tier: "low",
					reason: "Docs and copy.",
				},
			],
		},
		files: {
			protected: [
				...[
					"biome.json",
					"biome.jsonc",
					"eslint.config.*",
					".eslintrc*",
					"ruff.toml",
					".ruff.toml",
					"mypy.ini",
					".golangci.y*ml",
					"clippy.toml",
					".oxlintrc.json",
				].map((glob) => ({
					glob,
					reason:
						"Do not weaken the lint config. Tell the user which rule gets in the way and why.",
				})),
				{
					glob: ".env*",
					except: [".env.example", ".env.sample", ".env.template"],
					reason:
						"Env files hold real values. Do not edit them; tell the user which key is missing.",
				},
				{
					glob: `{${lockfiles.join(",")}}`,
					reason:
						"Lockfiles are written by the package manager. Change dependencies with its add or remove command instead.",
				},
			],
		},
	},
};

export const builtinResolver: PresetResolver = (name) => builtinPresets[name];
