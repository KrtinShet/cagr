import { basename } from "node:path";
import type { Config, PackageManager } from "../config/schema";
import type { Finding } from "./finding";

type Ecosystem = {
	name: string;
	managers: Partial<Record<PackageManager, string[]>>;
};

const ecosystems: Ecosystem[] = [
	{
		name: "JavaScript",
		managers: {
			bun: ["bun", "bunx"],
			npm: ["npm", "npx"],
			pnpm: ["pnpm", "pnpx"],
			yarn: ["yarn"],
		},
	},
	{
		name: "Python",
		managers: {
			uv: ["uv", "uvx"],
			pip: ["pip", "pip3"],
			poetry: ["poetry"],
			pipenv: ["pipenv"],
		},
	},
];

const useInstead: Record<PackageManager, string> = {
	bun: "bun or bunx",
	npm: "npm or npx",
	pnpm: "pnpm or pnpm dlx",
	yarn: "yarn",
	uv: "uv (`uv add`, `uv run`, `uv pip`)",
	pip: "pip",
	poetry: "poetry (`poetry add`, `poetry run`)",
	pipenv: "pipenv",
};

export function ecosystemOf(manager: PackageManager) {
	return ecosystems.find((ecosystem) => manager in ecosystem.managers);
}

export function packageManagerSummary(config: Config): string | null {
	const summaries = ecosystems.flatMap((ecosystem) => {
		const chosen = [
			...new Set(
				config.stack
					.map((stack) => stack.package_manager)
					.filter(
						(manager): manager is PackageManager =>
							manager !== null && manager in ecosystem.managers,
					),
			),
		];
		if (chosen.length === 0) return [];
		const allowed = chosen.flatMap(
			(manager) => ecosystem.managers[manager] ?? [],
		);
		const denied = Object.values(ecosystem.managers)
			.flat()
			.filter((program) => !allowed.includes(program));
		if (denied.length === 0) return [];
		return [
			`${denied.join(", ")} (use ${chosen.join(" or ")} for ${ecosystem.name})`,
		];
	});
	return summaries.join("; ") || null;
}

/** The program a command runs, as a package manager sees it: `python -m pip` is pip. */
function programName(words: string[]) {
	const first = basename(words[0] ?? "").replace(/\.exe$/i, "");
	if (/^python[0-9.]*$/.test(first) && words[1] === "-m")
		return basename(words[2] ?? "");
	return first;
}

export function packageManagerFinding(
	program: string[],
	config: Config,
): Finding | null {
	if (program.length === 0) return null;
	const name = programName(program);
	for (const ecosystem of ecosystems) {
		const allowed = config.stack
			.map((stack) => stack.package_manager)
			.filter(
				(manager): manager is PackageManager =>
					manager !== null && manager in ecosystem.managers,
			);
		if (allowed.length === 0) continue;
		const allowedPrograms = new Set(
			allowed.flatMap((manager) => ecosystem.managers[manager] ?? []),
		);
		const others = Object.values(ecosystem.managers)
			.flat()
			.filter((other) => !allowedPrograms.has(other));
		if (!others.includes(name)) continue;
		const chosen = [...new Set(allowed)];
		return {
			id: "package-manager",
			reason: `This repo uses ${chosen.join(" and ")} for ${ecosystem.name}. Use ${chosen.map((manager) => useInstead[manager]).join(" or ")} instead of ${list(others)}.`,
		};
	}
	return null;
}

function list(words: string[]) {
	return words.length <= 1
		? (words[0] ?? "")
		: `${words.slice(0, -1).join(", ")}, or ${words.at(-1)}`;
}
