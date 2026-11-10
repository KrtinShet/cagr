import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { insideRoot } from "../paths";
import { type RunResult, run } from "../run";
import { type Finding, newFindings } from "./match";

/** Only complete, file-scoped lint reports can establish inherited findings. */
export function parseBiome(
	result: RunResult,
	file: string,
	cwd = process.cwd(),
): Finding[] | null {
	if (result.timedOut || ![0, 1].includes(result.exitCode as number))
		return null;
	// Biome writes this reporter notice and failure footer even for valid JSON.
	const stderr = result.stderr?.trim() ?? "";
	if (
		stderr &&
		!/^The `json` and `json-pretty` reporters are experimental and may change in patch releases\.(?:\s+(?:lint|check) ━+\s+× Some errors were emitted while running checks\.)?$/.test(
			stderr,
		)
	)
		return null;
	try {
		const data = JSON.parse(result.stdout);
		const s = data.summary;
		if (
			s?.changed !== 0 ||
			s.unchanged !== 1 ||
			s.skipped !== 0 ||
			s.diagnosticsNotPrinted !== 0 ||
			!Array.isArray(data.diagnostics)
		)
			return null;
		const findings: Finding[] = [];
		for (const d of data.diagnostics) {
			const loc = d.location;
			if (
				!/^lint\//.test(d.category) ||
				!["error", "warning"].includes(d.severity) ||
				typeof d.message !== "string" ||
				!loc ||
				resolve(cwd, loc.path) !== resolve(file)
			)
				return null;
			const f = {
				code: d.category,
				message: d.message,
				severity: d.severity,
				line: loc.start?.line,
				endLine: loc.end?.line,
				column: loc.start?.column,
			};
			if (
				!Number.isInteger(f.line) ||
				f.line < 1 ||
				!Number.isInteger(f.endLine) ||
				f.endLine < f.line ||
				!Number.isInteger(f.column) ||
				f.column < 1
			)
				return null;
			findings.push(f);
		}
		if (
			s.errors !== findings.filter((f) => f.severity === "error").length ||
			s.warnings !== findings.filter((f) => f.severity === "warning").length ||
			s.infos !== 0 ||
			(result.exitCode === 1 && !s.errors)
		)
			return null;
		return findings;
	} catch {
		return null;
	}
}

export async function compareBiome(
	argv: string[],
	root: string,
	file: string,
	before: string,
	after: string,
	deadline: number,
	execute: typeof run = run,
) {
	if (insideRoot(root, file) === null) return null;
	const configs = ["biome.json", "biome.jsonc"].filter((name) =>
		existsSync(join(root, name)),
	);
	if (configs.length !== 1) return null;
	let dir = dirname(file);
	while (dir !== root) {
		if (
			["biome.json", "biome.jsonc"].some((name) => existsSync(join(dir, name)))
		)
			return null;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
	// JSONC comments and trailing commas are parsed by Bun's JSONC reader.
	let config: {
		vcs?: {
			enabled?: boolean;
			clientKind?: string;
			root?: string;
			useIgnoreFile?: boolean;
		};
	};
	try {
		config = Bun.JSONC.parse(
			readFileSync(join(root, configs[0] as string), "utf8"),
		) as typeof config;
	} catch {
		return null;
	}
	if (
		!config ||
		typeof config !== "object" ||
		"extends" in config ||
		"overrides" in config ||
		"plugins" in config
	)
		return null;
	const binary = join(root, "node_modules", ".bin", "biome");
	if (!existsSync(binary)) return null;
	const check = (args: string[], cwd = root) =>
		execute(args, cwd, {
			timeoutMs: Math.max(
				1,
				Math.floor(Math.min(250, deadline - performance.now())),
			),
		});
	if (config.vcs?.enabled) {
		if (config.vcs.clientKind !== "git" || config.vcs.root !== undefined)
			return null;
		if (config.vcs.useIgnoreFile) {
			const ignored = await check([
				"git",
				"check-ignore",
				"--no-index",
				"--",
				file,
			]);
			if (
				ignored.timedOut ||
				ignored.exitCode !== 1 ||
				ignored.stdout.trim() ||
				ignored.stderr?.trim()
			)
				return null;
		}
	}
	const args = [
		realpathSync(binary),
		...argv
			.slice(argv.indexOf("biome") + 1)
			.filter((a) => a !== "--no-errors-on-unmatched"),
		"--reporter=json",
		"--max-diagnostics=none",
		"--config-path",
		root,
	];
	const current = parseBiome(await check([...args, file]), file, root);
	if (!current) return null;
	if (current.length === 0) return { current: 0, fresh: [] };
	if (performance.now() >= deadline) return null;
	const workspace = mkdtempSync(join(tmpdir(), "cagr-biome-"));
	try {
		const target = join(workspace, relative(root, file));
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, before, { mode: 0o600 });
		const baseline = parseBiome(
			await check([...args, "--vcs-enabled=false", target], workspace),
			target,
			workspace,
		);
		if (!baseline || performance.now() >= deadline) return null;
		return {
			current: current.length,
			fresh: newFindings(before, after, baseline, current),
		};
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
}
