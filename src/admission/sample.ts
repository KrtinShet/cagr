import { readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../run";

let userScopes: Promise<boolean> | undefined;

export async function canScope(cwd: string) {
	if (process.platform !== "linux" || !Bun.which("systemd-run")) return false;
	userScopes ??= probeScope(cwd);
	return userScopes;
}

async function probeScope(cwd: string) {
	const version = await run(["systemd-run", "--version"], cwd, {
		timeoutMs: 1000,
	});
	if (Number(/^systemd (\d+)/.exec(version.stdout)?.[1] ?? 0) < 254)
		return false;
	const result = await run(
		[
			"systemd-run",
			"--user",
			"--scope",
			"--quiet",
			"--expand-environment=no",
			"-p",
			"MemoryMax=infinity",
			"-p",
			"OOMPolicy=kill",
			"--",
			"true",
		],
		cwd,
		{ timeoutMs: 1000 },
	);
	return result.ok;
}

function scopePeak(pid: number, unit: string) {
	try {
		const group = readFileSync(`/proc/${pid}/cgroup`, "utf8")
			.split("\n")
			.find((line) => line.startsWith("0::"))
			?.slice(3);
		if (!group?.endsWith(`/${unit}`)) return 0;
		const peak = Number(
			readFileSync(join("/sys/fs/cgroup", group, "memory.peak"), "utf8"),
		);
		return Number.isFinite(peak) ? peak : 0;
	} catch (error) {
		if (
			!["ENOENT", "EACCES", "ESRCH"].includes(
				(error as NodeJS.ErrnoException).code ?? "",
			)
		)
			throw error;
		return 0;
	}
}

function treeRss(root: number) {
	const ps = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,rss="], {
		timeout: 500,
		stderr: "pipe",
	});
	if (!ps.success) throw new Error("Could not sample process RSS with ps.");
	const children = new Map<number, number[]>();
	const rss = new Map<number, number>();
	for (const line of ps.stdout.toString().trim().split("\n")) {
		const [pid, ppid, kib] = line.trim().split(/\s+/).map(Number);
		if (pid === undefined || ppid === undefined || kib === undefined) continue;
		rss.set(pid, kib * 1024);
		if (pid === ppid) continue;
		const siblings = children.get(ppid) ?? [];
		siblings.push(pid);
		children.set(ppid, siblings);
	}
	let bytes = 0;
	const pending = [root];
	for (let i = 0; i < pending.length; i++) {
		const pid = pending[i] as number;
		bytes += rss.get(pid) ?? 0;
		pending.push(...(children.get(pid) ?? []));
	}
	return bytes;
}

export function memorySampler(pid: number, unit?: string) {
	let rss = 0;
	let cgroup = 0;
	let error: unknown;
	const sample = () => {
		try {
			if (unit) cgroup = Math.max(cgroup, scopePeak(pid, unit));
			if (!cgroup) rss = Math.max(rss, treeRss(pid));
		} catch (failure) {
			error = failure;
		}
	};
	const timer = setInterval(sample, 100);
	sample();
	return () => {
		clearInterval(timer);
		if (!cgroup && !rss && error) throw error;
		return {
			bytes: cgroup || rss,
			source: cgroup ? "cgroup memory.peak" : "sampled process tree RSS",
		};
	};
}
