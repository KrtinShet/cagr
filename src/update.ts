import { createHash } from "node:crypto";
import {
	accessSync,
	chmodSync,
	constants,
	existsSync,
	mkdtempSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { binaryName, targets } from "../scripts/targets";
import { version } from "./version";

export function normalizeVersion(value: string): string {
	const normalized = typeof value === "string" ? value.replace(/^v/, "") : "";
	if (
		!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(normalized)
	)
		throw new Error(
			"Invalid release version. Use a version such as 0.3.0 or v0.3.0.",
		);
	return normalized;
}

export function assetName(
	platform: string,
	arch: string,
	musl: boolean,
): string {
	const target = targets.find(
		(t) =>
			t.platform === platform &&
			t.arch === arch &&
			t.libc === (platform === "linux" && musl ? "musl" : ""),
	);
	if (!target)
		throw new Error(
			`No release binary for ${platform}/${arch}. Use a supported platform listed in the installation docs.`,
		);
	return binaryName(target);
}

export function checksumEntry(sums: string, asset: string): string {
	const entries = sums.split(/\r?\n/).flatMap((line) => {
		const match = /^([a-fA-F0-9]{64}) [ *](.+)$/.exec(line);
		return match?.[2] === asset && match[1] ? [match[1].toLowerCase()] : [];
	});
	if (entries.length !== 1 || !entries[0])
		throw new Error(
			`Missing or duplicate SHA256SUMS entry for ${asset}. Retry with an official release or fix CAGR_DOWNLOAD_URL.`,
		);
	return entries[0];
}

export const isNpmInstall = (path: string) =>
	/(^|[\\/])node_modules([\\/]|$)/.test(path);
export const isCompiled = (main: string) =>
	/^(?:\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/.test(main);

export function detectMusl(
	alpine = existsSync("/etc/alpine-release"),
	ldd: () => { stdout: Uint8Array; stderr: Uint8Array } = () =>
		Bun.spawnSync(["ldd", "--version"]),
): boolean {
	if (alpine) return true;
	const result = ldd();
	return /musl/i.test(`${result.stdout}${result.stderr}`);
}

export function replaceBinary(
	path: string,
	bytes: Uint8Array,
	windows: boolean,
	move = renameSync,
): void {
	const dir = dirname(path);
	const temp = mkdtempSync(join(dir, ".cagr-update-"));
	const staged = join(temp, "cagr");
	const old = `${path}.old`;
	try {
		writeFileSync(staged, bytes, { mode: 0o755 });
		chmodSync(staged, 0o755);
		if (windows) {
			rmSync(old, { force: true });
			move(path, old);
			try {
				move(staged, path);
			} catch (error) {
				move(old, path);
				throw error;
			}
		} else move(staged, path);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
}

export interface UpdateRuntime {
	current: string;
	execPath: string;
	main: string;
	platform: string;
	arch: string;
	musl: () => boolean;
	repo: string;
	downloadUrl?: string;
	fetch: (url: string) => Promise<Response>;
	writable: (dir: string) => void;
	replace: typeof replaceBinary;
}

const defaults = (): UpdateRuntime => ({
	current: version,
	execPath: process.execPath,
	main: Bun.main,
	platform: process.platform,
	arch: process.arch,
	musl: detectMusl,
	repo: process.env.CAGR_REPO || "krtinshet/cagr",
	downloadUrl: process.env.CAGR_DOWNLOAD_URL,
	fetch: (url) => fetch(url, { signal: AbortSignal.timeout(60_000) }),
	writable: (dir) => accessSync(dir, constants.W_OK),
	replace: replaceBinary,
});

export async function update(
	args: string[],
	runtime: UpdateRuntime = defaults(),
): Promise<{ code: number; message: string }> {
	try {
		const remaining = [...args];
		const check = remaining[0] === "--check";
		if (check) remaining.shift();
		let requested: string | undefined;
		if (remaining[0] === "--version" && remaining.length === 2) {
			requested = normalizeVersion(remaining[1] ?? "");
			remaining.splice(0);
		}
		if (remaining.length)
			throw new Error("Use cagr update [--check] [--version <v>].");
		if (isNpmInstall(runtime.execPath))
			throw new Error(
				"This binary is managed by a package manager. Run bun add -d @krtinshet/cagr@latest or npm i -D @krtinshet/cagr@latest instead.",
			);
		if (!isCompiled(runtime.main))
			throw new Error(
				"Updates require the compiled binary. Run cagr update using the installed compiled binary instead of bun run src/cli.ts.",
			);
		const get = async (url: string) => {
			try {
				const response = await runtime.fetch(url);
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				return new Response(await response.arrayBuffer());
			} catch {
				throw new Error(
					`Could not download ${url}. Check your connection and release URL, then retry cagr update.`,
				);
			}
		};
		let latest = requested;
		if (!latest) {
			const response = await get(
				`https://api.github.com/repos/${runtime.repo}/releases/latest`,
			);
			try {
				latest = normalizeVersion(
					((await response.json()) as { tag_name: string }).tag_name,
				);
			} catch {
				throw new Error(
					"Could not read the latest release version. Check CAGR_REPO or use cagr update --version <v>.",
				);
			}
		}
		const current = normalizeVersion(runtime.current);
		if (latest === current)
			return { code: 0, message: `cagr ${current} is the latest.` };
		if (check)
			return {
				code: 1,
				message: `cagr ${current} is installed; ${latest} is available. Run cagr update${requested ? ` --version ${requested}` : ""}.`,
			};
		const asset = assetName(
			runtime.platform,
			runtime.arch,
			runtime.platform === "linux" && runtime.musl(),
		);
		const dir = dirname(runtime.execPath);
		const permissionFix = `Cannot replace cagr in ${dir}. Fix directory permissions or re-run the install script with CAGR_INSTALL_DIR set to a writable directory.`;
		try {
			runtime.writable(dir);
		} catch {
			throw new Error(permissionFix);
		}
		const base = (
			runtime.downloadUrl ||
			`https://github.com/${runtime.repo}/releases/download/v${latest}`
		).replace(/\/$/, "");
		const sums = await (await get(`${base}/SHA256SUMS`)).text();
		const expected = checksumEntry(sums, asset);
		const bytes = new Uint8Array(
			await (await get(`${base}/${asset}`)).arrayBuffer(),
		);
		if (createHash("sha256").update(bytes).digest("hex") !== expected)
			throw new Error(
				`Checksum mismatch for ${asset}. Retry with an official release or fix CAGR_DOWNLOAD_URL.`,
			);
		try {
			runtime.replace(runtime.execPath, bytes, runtime.platform === "win32");
		} catch {
			throw new Error(permissionFix);
		}
		return {
			code: 0,
			message: `Updated cagr ${current} -> ${latest}.\nRun cagr sync in each repo and commit the changed files.`,
		};
	} catch (error) {
		const message =
			error instanceof Error
				? error.message.replace(/[\r\n]+/g, " ")
				: "Update failed. Retry with an official release.";
		return { code: 1, message: `cagr: ${message}` };
	}
}
