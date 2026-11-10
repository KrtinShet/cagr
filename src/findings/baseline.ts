import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { insideRoot } from "../paths";
import { type RunResult, run } from "../run";
import { stateFile } from "../turn-state";
import { compareBiome } from "./biome";
import { findingCommand } from "./command";
import { type Finding, newFindings } from "./match";
import { parseFindings } from "./parse";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export function baselineFile(root: string, session: string, file: string) {
	return join(
		dirname(stateFile(session)),
		"baselines-v1",
		hash(`${realpathSync(root)}\0${session}`),
		hash(resolve(file)),
	);
}

export function captureBaseline(root: string, session: string, file: string) {
	if (insideRoot(root, file) === null) return;
	const target = baselineFile(root, session, file);
	if (existsSync(target)) return;
	let source: string;
	try {
		source = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
		source = "";
	}
	mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
	try {
		writeFileSync(target, source, { flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}

export async function compareFindings(
	command: string,
	paths: string[],
	root: string,
	session: string,
	deadline = performance.now() + 750,
	execute: typeof run = run,
): Promise<{ old: number; problems: string[] } | null> {
	const adapter = findingCommand(command);
	if (!adapter) return null;
	let old = 0;
	let reported = 0;
	const problems: string[] = [];
	for (const path of paths) {
		if (performance.now() >= deadline) return null;
		const file = resolve(root, path),
			saved = baselineFile(root, session, file);
		if (!existsSync(saved)) return null;
		const source = readFileSync(saved, "utf8"),
			currentSource = readFileSync(file, "utf8");
		if (adapter.tool === "biome") {
			const compared = await compareBiome(
				adapter.argv,
				root,
				file,
				source,
				currentSource,
				deadline,
				execute,
			);
			if (!compared) return null;
			reported += compared.current;
			old += compared.current - compared.fresh.length;
			problems.push(
				...compared.fresh.map(
					(f) => `${path}:${f.line}:${f.column} ${f.code}: ${f.message}`,
				),
			);
			continue;
		}
		const argv = [
			...adapter.argv,
			...(adapter.tool === "eslint"
				? ["--format", "json", "--stdin", "--stdin-filename", file]
				: ["--output-format", "json", "--stdin-filename", file, "-"]),
		];
		const check = (stdin: string) =>
			execute(argv, root, {
				stdin,
				timeoutMs: Math.max(1, Math.min(250, deadline - performance.now())),
			});
		const current = parseFindings(
			adapter.tool,
			await check(currentSource),
			file,
		);
		if (!current) return null;
		if (current.length === 0) continue;
		reported += current.length;
		// Cache only completed reports, tied to exact invocation and baseline bytes.
		const cache = `${saved}.${hash(JSON.stringify(argv) + source + cacheIdentity(root, file, adapter.argv))}.json`;
		let baseline: Finding[] | null;
		try {
			baseline = parseFindings(
				adapter.tool,
				JSON.parse(readFileSync(cache, "utf8")) as RunResult,
				file,
			);
		} catch {
			const report = await check(source);
			baseline = parseFindings(adapter.tool, report, file);
			if (baseline)
				writeFileSync(cache, JSON.stringify(report), { mode: 0o600 });
		}
		if (!baseline) return null;
		const fresh = newFindings(source, currentSource, baseline, current);
		old += current.length - fresh.length;
		problems.push(
			...fresh.map(
				(f) => `${path}:${f.line}:${f.column} ${f.code}: ${f.message}`,
			),
		);
	}
	return reported ? { old, problems } : null;
}

/** Config and installed-tool changes cannot reuse a completed diagnostic report. */
function cacheIdentity(root: string, file: string, argv: string[]) {
	const inputs: string[] = [];
	let dir = dirname(file);
	for (;;) {
		for (const name of readdirSync(dir).sort()) {
			if (
				!/^(?:eslint\.config\.|\.eslintrc|ruff\.toml$|\.ruff\.toml$|pyproject\.toml$|package\.json$|.*lock(?:b|\.yaml|\.json)?$)/.test(
					name,
				)
			)
				continue;
			const path = join(dir, name);
			if (statSync(path).isFile())
				inputs.push(path, readFileSync(path, "utf8"));
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	for (const word of argv) {
		const executable = Bun.which(word, { cwd: root });
		const local = join(root, "node_modules", ".bin", word);
		for (const path of [executable, local])
			if (path && existsSync(path)) {
				const stat = statSync(path);
				inputs.push(path, String(stat.mtimeMs), String(stat.size));
			}
	}
	return hash(inputs.join("\0"));
}
