// Platforms cagr ships a binary for.
// x64 builds use the baseline CPU target so they also run on machines without AVX2.
export const targets = [
	{ bun: "bun-darwin-arm64", platform: "darwin", arch: "arm64", libc: "" },
	{ bun: "bun-darwin-x64-baseline", platform: "darwin", arch: "x64", libc: "" },
	{ bun: "bun-linux-x64-baseline", platform: "linux", arch: "x64", libc: "" },
	{ bun: "bun-linux-arm64", platform: "linux", arch: "arm64", libc: "" },
	{
		bun: "bun-linux-x64-musl-baseline",
		platform: "linux",
		arch: "x64",
		libc: "musl",
	},
	{
		bun: "bun-linux-arm64-musl",
		platform: "linux",
		arch: "arm64",
		libc: "musl",
	},
	{ bun: "bun-windows-x64-baseline", platform: "win32", arch: "x64", libc: "" },
] as const;
export type Target = (typeof targets)[number];

export const binaryName = (target: Target) =>
	`cagr-${target.platform === "win32" ? "windows" : target.platform}-${target.arch}${target.libc ? `-${target.libc}` : ""}${target.platform === "win32" ? ".exe" : ""}`;
