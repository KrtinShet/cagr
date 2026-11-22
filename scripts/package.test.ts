import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binaryName, targets } from "./targets";

test("npm manifests use the GitHub repository casing required by provenance", async () => {
	const root = mkdtempSync(join(tmpdir(), "cagr-package-"));
	const source = join(import.meta.dir, "..");
	try {
		for (const path of [
			"scripts/package.ts",
			"scripts/targets.ts",
			"src/version.ts",
			"packaging",
			"LICENSE",
			"README.md",
		]) {
			cpSync(join(source, path), join(root, path), { recursive: true });
		}
		const dist = join(root, "dist");
		mkdirSync(dist);
		await Bun.write(join(dist, binaryName(targets[0])), "fixture binary");

		const result = Bun.spawnSync([process.execPath, "scripts/package.ts"], {
			cwd: root,
		});
		expect(result.exitCode, result.stderr.toString()).toBe(0);

		for (const name of ["cagr", "cagr-darwin-arm64"]) {
			const manifest = await Bun.file(
				join(dist, "npm", name, "package.json"),
			).json();
			expect(manifest.repository.url).toBe(
				"git+https://github.com/KrtinShet/cagr.git",
			);
			expect(manifest.bugs.url).toBe(
				"https://github.com/KrtinShet/cagr/issues",
			);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
