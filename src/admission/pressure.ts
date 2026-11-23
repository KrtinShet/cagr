import { readFileSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import { join } from "node:path";
import type { Config } from "../config/schema";

export const gib = 1024 ** 3;
export const supportsAdmission =
	process.platform === "darwin" || process.platform === "linux";
export type Pressure = {
	elevated: boolean;
	description: string;
	available?: number;
};
type Settings = Config["admission"];

export function parseLinuxMemory(psi: string, meminfo: string) {
	const averages = Object.fromEntries(
		[...psi.matchAll(/^(some|full) avg10=([\d.]+)/gm)].map(([, key, value]) => [
			key,
			Number(value),
		]),
	);
	const available = /^MemAvailable:\s+(\d+)\s+kB/m.exec(meminfo)?.[1];
	if (
		averages.some === undefined ||
		averages.full === undefined ||
		available === undefined ||
		!Number.isFinite(averages.some) ||
		!Number.isFinite(averages.full)
	)
		throw new Error(
			"Missing Linux memory pressure or MemAvailable. Check /proc before retrying.",
		);
	return {
		some: averages.some,
		full: averages.full,
		available: Number(available) * 1024,
	};
}

function read(argv: string[]) {
	const result = Bun.spawnSync(argv, { timeout: 500, stderr: "pipe" });
	if (!result.success)
		throw new Error(`Could not read memory data with ${argv.join(" ")}.`);
	return result.stdout.toString();
}

export function pressureReader(config: Settings): () => Pressure {
	let lastSwap: number | undefined;
	return () => {
		if (process.platform === "linux") {
			const { some, full, available } = parseLinuxMemory(
				readFileSync("/proc/pressure/memory", "utf8"),
				readFileSync("/proc/meminfo", "utf8"),
			);
			return {
				elevated:
					some > config.linux_some_avg10 || full > config.linux_full_avg10,
				available,
				description: `PSI some avg10=${some}, full avg10=${full}, ${(available / gib).toFixed(1)} GiB available`,
			};
		}
		const data = read([
			"/usr/sbin/sysctl",
			"-n",
			"kern.memorystatus_vm_pressure_level",
			"vm.swapusage",
		]);
		const level = Number(data.split("\n")[0]);
		const used = /used\s*=\s*([\d.]+)([KMG])/i.exec(data);
		if (![1, 2, 4].includes(level) || !used)
			throw new Error("Could not read macOS memory pressure and swap usage.");
		const unit = used[2]?.toUpperCase();
		const swap =
			Number(used[1]) * (unit === "G" ? 1024 : unit === "K" ? 1 / 1024 : 1);
		const growth = lastSwap === undefined ? 0 : swap - lastSwap;
		lastSwap = swap;
		return {
			elevated:
				level >= config.mac_pressure_level ||
				growth > config.mac_swap_growth_mib,
			description: `macOS level ${level}, ${swap.toFixed(2)} MiB swap used, ${growth.toFixed(2)} MiB change`,
		};
	};
}

export function dockerMemory() {
	if (process.platform !== "darwin" || !Bun.which("docker")) return 0;
	// Use Docker Desktop's local socket, regardless of the active Docker context.
	const result = Bun.spawnSync(
		[
			"docker",
			"--host",
			`unix://${join(homedir(), ".docker/run/docker.sock")}`,
			"info",
			"--format",
			"{{.OperatingSystem}}|{{.MemTotal}}",
		],
		{ timeout: 1000, stderr: "pipe" },
	);
	const [os, bytes] = result.stdout.toString().trim().split("|");
	return result.success && os?.startsWith("Docker Desktop") && Number(bytes) > 0
		? Number(bytes)
		: 0;
}

export function usableMemory(pressure: Pressure, dockerBytes: number) {
	let available = pressure.available;
	if (available === undefined) {
		const vm = read(["/usr/bin/vm_stat"]);
		const pageSize = Number(/page size of (\d+) bytes/.exec(vm)?.[1]);
		if (!pageSize)
			throw new Error("Could not read the page size from vm_stat.");
		const pages = [
			...vm.matchAll(/^Pages (?:free|inactive|speculative):\s+(\d+)/gm),
		].reduce((sum, match) => sum + Number(match[1]), 0);
		available = pages * pageSize;
	}
	// Available memory already reflects the VM's live use. Cap it again using the VM's full budget.
	return Math.min(available, totalmem() - dockerBytes) - 2 * gib;
}
