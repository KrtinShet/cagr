import { resolveConfig } from "../config/load";
import type { RawConfig } from "../config/presets";

export const root = "/repo";

export function config(raw: RawConfig = {}) {
	return resolveConfig(raw, root, "test.toml");
}

/** gerb-crm's values, which the ported tests were written against. */
export const prisma = "Use `bun run db:migrate --name <change>`.";
export const gerb = config({
	extends: ["recommended"],
	git: { skip_env: "CRM_SKIP_HOOKS" },
	stack: [{ language: "typescript", package_manager: "bun" }],
	commands: {
		blocked: [
			{ match: "prisma db push", reason: prisma },
			{ match: "prisma migrate dev", reason: prisma },
			{ match: "prisma migrate reset", reason: prisma },
		],
	},
	files: {
		protected: [
			{
				glob: "packages/db/prisma/migrations/**",
				reason: "Migrations are written by `bun run db:migrate`.",
			},
		],
	},
});
