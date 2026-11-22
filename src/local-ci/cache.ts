import { Database, SQLiteError } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gitContext } from "../git";

export class LocalCiError extends Error {}

export async function watchPaths(
	root: string,
	home = homedir(),
	configHome = process.env.XDG_CONFIG_HOME || join(home, ".config"),
) {
	const { commonDir } = await gitContext(root);
	if (!commonDir) return null;
	const id = createHash("sha256").update(commonDir).digest("hex").slice(0, 24);
	const label = `cagr-ci-${id}`;
	const cache = join(home, ".cache", "cagr", label);
	return {
		label,
		cache,
		lastRun: join(cache, "last-run"),
		log: join(cache, "watch.log"),
		plist: join(home, "Library", "LaunchAgents", `${label}.plist`),
		service: join(configHome, "systemd", "user", `${label}.service`),
		timer: join(configHome, "systemd", "user", `${label}.timer`),
	};
}

export type WatchPaths = NonNullable<Awaited<ReturnType<typeof watchPaths>>>;

export function makeCache(path: string) {
	mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function lockWatch(cache: string): Database | null {
	makeCache(cache);
	// SQLite's OS lock is released when the holder exits, even after SIGKILL.
	const lock = new Database(join(cache, "watch.lock"));
	try {
		lock.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
		return lock;
	} catch (error) {
		lock.close();
		if (error instanceof SQLiteError && error.code === "SQLITE_BUSY")
			return null;
		throw error;
	}
}
