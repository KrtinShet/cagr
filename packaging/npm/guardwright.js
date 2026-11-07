#!/usr/bin/env node
// Runs the guardwright binary from the platform package npm installed next to this one.
const { spawnSync } = require("node:child_process");

const musl = () =>
	process.platform === "linux" &&
	!process.report?.getReport().header.glibcVersionRuntime;
const os = process.platform === "win32" ? "windows" : process.platform;
const name = `@guardwright/cli-${os}-${process.arch}${musl() ? "-musl" : ""}`;
const exe = process.platform === "win32" ? "guardwright.exe" : "guardwright";

let binary;
try {
	binary = require.resolve(`${name}/${exe}`);
} catch {
	console.error(
		`guardwright: ${name} is not installed. Reinstall without --no-optional, or use the install script.`,
	);
	process.exit(1);
}
const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
	console.error(`guardwright: ${result.error.message}`);
	process.exit(1);
}
process.exit(result.status ?? 1);
