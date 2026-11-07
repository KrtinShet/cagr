export type RawConfig = Record<string, unknown>;

/**
 * Turns a name in `extends` into a raw config, or returns undefined when it
 * does not handle that name. v0.1 has only built-in presets. Presets from git
 * URLs (v0.2) plug in as another resolver that reads a local cache filled by
 * `guardwright sync`, so hooks never touch the network.
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
		git: {
			protected_branch: "main",
			branch_name: "type/name",
			commit_message: "conventional",
			block_force_push: true,
			block_hook_skips: true,
		},
		files: {
			protected: [
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
