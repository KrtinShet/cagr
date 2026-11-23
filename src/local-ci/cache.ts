import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gitContext } from "../git";
import { tryLock } from "../lock";

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

export function lockWatch(cache: string) {
	makeCache(cache);
	return tryLock(join(cache, "watch.lock"));
}
