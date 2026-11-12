import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assetName,
	checksumEntry,
	detectMusl,
	isCompiled,
	isNpmInstall,
	normalizeVersion,
	replaceBinary,
	type UpdateRuntime,
	update,
} from "./update";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "cagr-update-test-"));
	dirs.push(dir);
	const path = join(dir, "cagr");
	writeFileSync(path, "old");
	return { dir, path };
}
const payload = "new binary";
const hash = createHash("sha256").update(payload).digest("hex");
function runtime(overrides: Partial<UpdateRuntime> = {}) {
	const urls: string[] = [];
	const options: UpdateRuntime = {
		current: "0.3.0",
		execPath: "/opt/bin/cagr",
		main: "/$bunfs/root/entry.ts",
		platform: "darwin",
		arch: "arm64",
		musl: () => false,
		repo: "krtinshet/cagr",
		fetch: async (url) => {
			urls.push(url);
			return new Response(
				url.endsWith("/latest")
					? JSON.stringify({ tag_name: "v0.4.0" })
					: url.endsWith("SHA256SUMS")
						? `${hash}  cagr-darwin-arm64\n`
						: payload,
			);
		},
		writable: () => {},
		replace: () => {},
		...overrides,
	};
	return { options, urls };
}

test("asset names reuse every supported build target and reject unsupported ones", () => {
	for (const [os, arch, musl, name] of [
		["darwin", "arm64", false, "cagr-darwin-arm64"],
		["darwin", "x64", true, "cagr-darwin-x64"],
		["linux", "x64", false, "cagr-linux-x64"],
		["linux", "arm64", false, "cagr-linux-arm64"],
		["linux", "x64", true, "cagr-linux-x64-musl"],
		["linux", "arm64", true, "cagr-linux-arm64-musl"],
		["win32", "x64", false, "cagr-windows-x64.exe"],
	] as const)
		expect(assetName(os, arch, musl)).toBe(name);
	expect(() => assetName("win32", "arm64", false)).toThrow(
		"Use a supported platform",
	);
});
test("versions normalize the tag prefix and reject invalid versions", () => {
	for (const value of ["v0.3.0", "0.3.0"])
		expect(normalizeVersion(value)).toBe("0.3.0");
	expect(normalizeVersion("v1.0.0-rc.1+build")).toBe("1.0.0-rc.1+build");
	for (const value of ["", "latest", "../foo", "v1.0", "1.0.0/evil"])
		expect(() => normalizeVersion(value)).toThrow("Use a version");
});
test("checksum parsing requires exactly one valid entry for the exact asset", () => {
	expect(checksumEntry(`${hash.toUpperCase()} *cagr\r\n`, "cagr")).toBe(hash);
	for (const sums of [
		"",
		`${hash}  other`,
		"bad  cagr",
		`${hash}  cagr\n${hash}  cagr`,
	])
		expect(() => checksumEntry(sums, "cagr")).toThrow(
			"Retry with an official release",
		);
});
test("package and compiled path detection works for Unix and Windows", () => {
	for (const path of [
		"/a/node_modules/cagr/bin",
		"C:\\app\\node_modules\\cagr\\cagr.exe",
		"node_modules/cagr",
	])
		expect(isNpmInstall(path)).toBe(true);
	expect(isNpmInstall("/a/node_modules-other/cagr")).toBe(false);
	for (const path of [
		"/$bunfs/root/cli.ts",
		"B:/~BUN/root/cli.ts",
		"B:\\~BUN\\root\\cli.ts",
	])
		expect(isCompiled(path)).toBe(true);
	expect(isCompiled("/repo/src/cli.ts")).toBe(false);
});
test("latest and check mode exit codes never write", async () => {
	for (const check of [false, true]) {
		const { options, urls } = runtime({
			current: "v0.4.0",
			replace: () => {
				throw new Error("must not write");
			},
		});
		expect(await update(check ? ["--check"] : [], options)).toEqual({
			code: 0,
			message: "cagr 0.4.0 is the latest.",
		});
		expect(urls).toHaveLength(1);
	}
	const { options, urls } = runtime();
	expect(await update(["--check"], options)).toEqual({
		code: 1,
		message: "cagr 0.3.0 is installed; 0.4.0 is available. Run cagr update.",
	});
	expect(urls).toHaveLength(1);
});
test("update verifies bytes, replaces only the injected path and prints sync advice", async () => {
	const { path } = fixture();
	const { options, urls } = runtime({ execPath: path, replace: replaceBinary });
	const result = await update([], options);
	expect(result.code).toBe(0);
	expect(result.message).toContain("Updated cagr 0.3.0 -> 0.4.0.");
	expect(result.message).toContain("commit the changed files");
	expect(readFileSync(path, "utf8")).toBe(payload);
	expect(urls).toContain(
		"https://github.com/krtinshet/cagr/releases/download/v0.4.0/cagr-darwin-arm64",
	);
});
test("explicit versions support downgrade, overrides, and check without latest lookup", async () => {
	for (const version of ["0.2.0", "v0.2.0"]) {
		const { options, urls } = runtime({
			repo: "owner/fork",
			downloadUrl: "https://mirror.test/",
		});
		expect((await update(["--version", version], options)).message).toContain(
			"0.3.0 -> 0.2.0",
		);
		expect(urls).toEqual([
			"https://mirror.test/SHA256SUMS",
			"https://mirror.test/cagr-darwin-arm64",
		]);
	}
	const { options, urls } = runtime({ repo: "owner/fork" });
	expect((await update(["--check", "--version", "v0.3.0"], options)).code).toBe(
		0,
	);
	expect(urls).toEqual([]);
	await update([], options);
	expect(urls[0]).toBe(
		"https://api.github.com/repos/owner/fork/releases/latest",
	);
});
test("npm and source installs refuse before network access", async () => {
	for (const overrides of [
		{ execPath: "/repo/node_modules/cagr/cagr" },
		{ main: "/repo/src/cli.ts" },
	]) {
		const { options, urls } = runtime(overrides);
		const result = await update([], options);
		expect(result.code).toBe(1);
		expect(result.message).toContain(
			overrides.execPath
				? "bun add -d @krtinshet/cagr@latest or npm i -D"
				: "compiled binary",
		);
		expect(urls).toEqual([]);
	}
});
test("invalid arguments fail with usage advice", async () => {
	for (const args of [
		["--version"],
		["--version", ""],
		["--bad"],
		["extra"],
		["--version", "../oops"],
	]) {
		const { options, urls } = runtime();
		expect((await update(args, options)).code).toBe(1);
		expect(urls).toEqual([]);
	}
});
test("checksum mismatches and missing entries never replace the binary", async () => {
	for (const sums of [
		`${"0".repeat(64)}  cagr-darwin-arm64`,
		`${hash}  other`,
	]) {
		let replaced = false;
		const { options } = runtime({
			fetch: async (url) =>
				new Response(url.endsWith("SHA256SUMS") ? sums : payload),
			replace: () => {
				replaced = true;
			},
		});
		const result = await update(["--version", "0.4.0"], options);
		expect(result.code).toBe(1);
		expect(result.message).toContain("fix CAGR_DOWNLOAD_URL");
		expect(replaced).toBe(false);
	}
});
test("network and HTTP failures name the URL and a next step", async () => {
	for (const fetcher of [
		async () => {
			throw new Error("offline\nprivate detail");
		},
		async () => new Response("", { status: 404 }),
	]) {
		const { options } = runtime({ fetch: fetcher });
		const result = await update([], options);
		expect(result.code).toBe(1);
		expect(result.message).toContain("Check your connection and release URL");
		expect(result.message).not.toContain("\n");
	}
});
test("directory and replacement failures give permission recovery advice", async () => {
	for (const key of ["writable", "replace"] as const) {
		const { options } = runtime({
			[key]: () => {
				throw new Error("EACCES");
			},
		});
		const result = await update([], options);
		expect(result.code).toBe(1);
		expect(result.message).toContain("/opt/bin");
		expect(result.message).toContain("CAGR_INSTALL_DIR");
	}
});
test("Unix replacement sets executable mode and removes its staging directory", () => {
	const { dir, path } = fixture();
	replaceBinary(path, Buffer.from(payload), false);
	expect(readFileSync(path, "utf8")).toBe(payload);
	expect(statSync(path).mode & 0o777).toBe(0o755);
	expect(readdirSync(dir)).toEqual(["cagr"]);
});
test("Windows replacement keeps the old binary and removes a previous backup", () => {
	const { dir, path } = fixture();
	writeFileSync(`${path}.old`, "older");
	replaceBinary(path, Buffer.from(payload), true);
	expect(readFileSync(path, "utf8")).toBe(payload);
	expect(readFileSync(`${path}.old`, "utf8")).toBe("old");
	expect(readdirSync(dir).sort()).toEqual(["cagr", "cagr.old"]);
});
test("Windows replacement restores the old binary if installing the new one fails", () => {
	const { dir, path } = fixture();
	expect(() =>
		replaceBinary(path, Buffer.from(payload), true, (from, to) => {
			if (String(from).includes(".cagr-update-")) throw new Error("denied");
			renameSync(from, to);
		}),
	).toThrow("denied");
	expect(readFileSync(path, "utf8")).toBe("old");
	expect(existsSync(`${path}.old`)).toBe(false);
	expect(readdirSync(dir)).toEqual(["cagr"]);
});

test("musl detection handles Alpine, stdout, stderr and glibc", () => {
	expect(
		detectMusl(true, () => {
			throw new Error("must not run ldd");
		}),
	).toBe(true);
	for (const [stdout, stderr, expected] of [
		["musl libc", "", true],
		["", "musl libc", true],
		["ldd (GNU libc)", "", false],
		["", "", false],
	] as const)
		expect(
			detectMusl(false, () => ({
				stdout: Buffer.from(stdout),
				stderr: Buffer.from(stderr),
			})),
		).toBe(expected);
});
test("invalid latest responses give release lookup advice", async () => {
	for (const response of ["not json", "{}", "null", '{"tag_name":"invalid"}']) {
		const { options } = runtime({ fetch: async () => new Response(response) });
		const result = await update([], options);
		expect(result.code).toBe(1);
		expect(result.message).toContain(
			"Check CAGR_REPO or use cagr update --version",
		);
	}
});
test("body read failures are reported as network errors", async () => {
	const { options } = runtime({
		fetch: async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.error(new Error("connection lost"));
					},
				}),
			),
	});
	expect((await update([], options)).message).toContain(
		"Check your connection and release URL",
	);
});
test("update selects musl and Windows binaries and the matching replacement mode", async () => {
	for (const [platform, arch, musl, asset] of [
		["linux", "x64", true, "cagr-linux-x64-musl"],
		["win32", "x64", false, "cagr-windows-x64.exe"],
	] as const) {
		let replaced = false;
		const { options, urls } = runtime({
			platform,
			arch,
			musl: () => musl,
			fetch: async (url) => {
				urls.push(url);
				return new Response(
					url.endsWith("SHA256SUMS") ? `${hash}  ${asset}` : payload,
				);
			},
			replace: (_path, bytes, windows) => {
				replaced = true;
				expect(Buffer.from(bytes).toString()).toBe(payload);
				expect(windows).toBe(platform === "win32");
			},
		});
		expect((await update(["--version", "0.4.0"], options)).code).toBe(0);
		expect(replaced).toBe(true);
		expect(urls[1]).toEndWith(`/${asset}`);
	}
});
test("failed Unix rename leaves the installed binary intact and cleans staging", () => {
	const { dir, path } = fixture();
	expect(() =>
		replaceBinary(path, Buffer.from(payload), false, () => {
			throw new Error("denied");
		}),
	).toThrow("denied");
	expect(readFileSync(path, "utf8")).toBe("old");
	expect(readdirSync(dir)).toEqual(["cagr"]);
});
