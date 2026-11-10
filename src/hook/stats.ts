import { AsyncLocalStorage } from "node:async_hooks";
import {
	appendFileSync,
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export type Outcome =
	| "deny"
	| "block"
	| "stop-escape"
	| "fail-open"
	| "old-findings"
	| "session";
export type Observation = {
	id: string;
	decision: Outcome;
	target: string;
	key?: string;
};
export type StatEvent = Observation & {
	time: string;
	event: string;
	agent: string;
	session: string;
	repeat: boolean;
};
const context = new AsyncLocalStorage<Observation[]>();
export const collectStats = <T>(entries: Observation[], action: () => T) =>
	context.run(entries, action);
export function observe(id: string, decision: Outcome, target = "") {
	context.getStore()?.push({ id, decision, target: target.slice(0, 200) });
}

/** Only known subcommands are retained: the second word may itself be a secret. */
export function commandTarget(command: string): string {
	const words = command.trim().split(/\s+/);
	const program = basename(words[0] ?? "");
	if (!/^[a-zA-Z][\w.-]{0,63}$/.test(program)) return "command";
	const sub = words[1] ?? "";
	const safe: Record<string, string[]> = {
		git: [
			"push",
			"commit",
			"config",
			"checkout",
			"switch",
			"reset",
			"clean",
			"merge",
			"rebase",
		],
		gh: ["pr", "issue", "api"],
		bun: ["run", "test", "add", "install", "remove", "build"],
		npm: ["run", "install", "i", "ci", "test"],
		pnpm: ["run", "install", "add", "test"],
		yarn: ["run", "install", "add", "test"],
		uv: ["run", "pip", "add", "sync"],
	};
	return safe[program]?.includes(sub) ? `${program} ${sub}` : program;
}

export const statsFile = (root: string) =>
	join(tmpdir(), "cagr", `stats-${Bun.hash(root).toString(36)}.jsonl`);
const maxBytes = 512_000;
export const commandId = (phase: string, command: string) =>
	`${phase}:${commandTarget(command)}:${Bun.hash(command).toString(36)}`;
function readText(path: string) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}
export function readStats(root: string): StatEvent[] {
	const path = statsFile(root);
	return `${readText(`${path}.1`)}${readText(path)}`
		.split("\n")
		.flatMap((line) => {
			try {
				const entry = JSON.parse(line);
				return typeof entry.time === "string" &&
					typeof entry.id === "string" &&
					typeof entry.session === "string" &&
					typeof entry.decision === "string"
					? [entry as StatEvent]
					: [];
			} catch {
				return [];
			}
		})
		.slice(-5000);
}

/** Append only between rotations. Failure, including lock contention, loses counts, never a hook. */
export function recordStats(
	root: string,
	event: string,
	agent: string,
	session: string,
	entries: Observation[],
) {
	if (!entries.length) return;
	let lock: string | undefined;
	try {
		const path = statsFile(root);
		mkdirSync(join(tmpdir(), "cagr"), { recursive: true });
		const lockPath = `${path}.lock`;
		closeSync(openSync(lockPath, "wx", 0o600));
		lock = lockPath;
		const previous = `${readText(`${path}.1`)}${readText(path)}`;
		const hashedSession = Bun.hash(session).toString(36);
		const time = new Date().toISOString();
		const seen = new Set<string>();
		const identities = new Set<string>();
		const unique = entries.filter((e) => {
			const identity = JSON.stringify([e.id, e.decision, e.target, e.key]);
			if (identities.has(identity)) return false;
			identities.add(identity);
			return true;
		});
		const lines = unique
			.map((entry) => {
				const key = Bun.hash(
					JSON.stringify([
						hashedSession,
						event,
						entry.id,
						entry.key ?? entry.target,
					]),
				).toString(36);
				const blocked = entry.decision === "deny" || entry.decision === "block";
				const repeat =
					blocked && (previous.includes(`"key":"${key}"`) || seen.has(key));
				if (blocked) seen.add(key);
				return JSON.stringify({
					...entry,
					key: blocked ? key : undefined,
					time,
					event,
					agent,
					session: hashedSession,
					repeat,
				});
			})
			.map((line) => `${line}\n`);
		let size = 0;
		try {
			size = statSync(path).size;
		} catch {}
		let chunk = "";
		for (const line of lines) {
			const bytes = Buffer.byteLength(line);
			if (bytes > maxBytes) continue;
			if (size + bytes > maxBytes) {
				if (chunk) appendFileSync(path, chunk, { mode: 0o600 });
				renameSync(path, `${path}.1`);
				size = 0;
				chunk = "";
			}
			chunk += line;
			size += bytes;
		}
		if (chunk) appendFileSync(path, chunk, { mode: 0o600 });
	} catch {
	} finally {
		if (lock) {
			try {
				unlinkSync(lock);
			} catch {}
		}
	}
}

export const retryHint =
	"agents retry after this block; make its message say more clearly what to do instead";
export function aggregateStats(
	entries: StatEvent[],
	ids: string[],
	days = 7,
	now = Date.now(),
) {
	const window = entries.filter(
		(e) =>
			Date.parse(e.time) >= now - days * 86_400_000 &&
			Date.parse(e.time) <= now,
	);
	const sessions = new Set(window.map((e) => e.session)).size;
	const rows = [
		...new Set([
			...ids,
			...window.filter((e) => e.decision !== "session").map((e) => e.id),
		]),
	]
		.map((id) => {
			const hits = window.filter(
				(e) => e.id === id && e.decision !== "session",
			);
			const counts: Partial<Record<Outcome, number>> = {};
			for (const hit of hits)
				counts[hit.decision] = (counts[hit.decision] ?? 0) + 1;
			const repeats = hits.filter((e) => e.repeat).length;
			const blocks = (counts.block ?? 0) + (counts.deny ?? 0);
			return {
				id,
				count: hits.length,
				counts,
				repeats,
				lastSeen:
					hits
						.map((e) => e.time)
						.sort()
						.at(-1) ?? null,
				sessionShare: sessions
					? new Set(hits.map((e) => e.session)).size / sessions
					: 0,
				hint: !hits.length
					? "never fired in this window"
					: repeats >= 2 && repeats / blocks >= 0.5
						? retryHint
						: null,
			};
		})
		.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
	return { days, sessions, rows };
}
export function statsReport(stats: ReturnType<typeof aggregateStats>) {
	return [
		`Decisions in ${stats.days} days (${stats.sessions} observed sessions, retained local history):`,
		...stats.rows.map(
			(r) =>
				`${r.id}: ${r.count}, ${
					Object.entries(r.counts)
						.map(([k, v]) => `${k} ${v}`)
						.join(", ") || "no decisions"
				}, repeats ${r.repeats}, sessions ${Math.round(r.sessionShare * 100)}%, last ${r.lastSeen ?? "never"}${r.hint ? `. ${r.hint}` : ""}`,
		),
	].join("\n");
}
export function statsSummary(root: string) {
	const stats = aggregateStats(readStats(root), []);
	const rows = stats.rows
		.map((r) => ({
			id: r.id,
			count: (r.counts.deny ?? 0) + (r.counts.block ?? 0),
		}))
		.sort((a, b) => b.count - a.count);
	return `Blocks: ${rows.reduce((sum, r) => sum + r.count, 0)} in 7 days${rows[0]?.count ? `, top: ${rows[0].id} ${rows[0].count}` : ""}. Run \`cagr stats\`.`;
}
