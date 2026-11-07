// Compiles one self-contained guardwright binary per platform into dist/.
// Usage: bun scripts/build.ts [--host] [target...]
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { prebuildDir } from "../src/rules/languages";
import { binaryName, targets } from "./targets";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");

const args = process.argv.slice(2);
const host = args.includes("--host");
const wanted = targets.filter((target) =>
	host
		? target.platform === process.platform &&
			target.arch === process.arch &&
			target.libc === ""
		: args.length === 0 || args.includes(target.bun),
);

// Cross builds embed each platform's napi package, which bun installs only when asked for every platform.
if (!host) await $`bun install ${"--os=*"} ${"--cpu=*"}`.cwd(root).quiet();

mkdirSync(dist, { recursive: true });
for (const target of wanted) {
	const dir = prebuildDir(target.platform, target.arch);
	const parser = (lang: string) =>
		JSON.stringify(
			join(
				root,
				"node_modules",
				"@ast-grep",
				`lang-${lang}`,
				"prebuilds",
				dir as string,
				"parser.so",
			),
		);
	const entry = join(dist, `entry-${target.bun}.ts`);
	writeFileSync(
		entry,
		[
			`import python from ${parser("python")} with { type: "file" };`,
			`import go from ${parser("go")} with { type: "file" };`,
			`import rust from ${parser("rust")} with { type: "file" };`,
			`import { runCli } from ${JSON.stringify(join(root, "src/cli.ts"))};`,
			`import { setEmbeddedParsers } from ${JSON.stringify(join(root, "src/rules/languages.ts"))};`,
			"setEmbeddedParsers({ python, go, rust });",
			"runCli(process.argv.slice(2));",
			"",
		].join("\n"),
	);
	const outfile = join(dist, binaryName(target));
	await $`bun build ${entry} --compile --minify --sourcemap=none --target=${target.bun} --outfile ${outfile}`
		.cwd(root)
		.quiet();
	rmSync(entry);
	console.log(
		`${binaryName(target)}  ${(statSync(outfile).size / 1024 / 1024).toFixed(1)} MB`,
	);
}
