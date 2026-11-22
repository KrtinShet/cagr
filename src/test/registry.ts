import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../run";

const short = (name: string) => name.split("/").at(-1) ?? name;

/** A local npm registry serving `packages` (name to versions), so package managers run without the network. */
export async function localRegistry(packages: Record<string, string[]>) {
	const folder = await mkdtemp(join(tmpdir(), "gw-registry-"));
	const tarballs = new Map<string, Uint8Array>();
	for (const [name, versions] of Object.entries(packages))
		for (const version of versions) {
			const source = join(folder, name, version);
			await mkdir(join(source, "package"), { recursive: true });
			await writeFile(
				join(source, "package/package.json"),
				JSON.stringify({ name, version }),
			);
			const file = `${source}.tgz`;
			const packed = await run(
				["tar", "--format=ustar", "-czf", file, "-C", source, "package"],
				folder,
				{ env: { COPYFILE_DISABLE: "1" } },
			);
			if (!packed.ok) throw new Error(packed.output);
			tarballs.set(`${name}@${version}`, await readFile(file));
		}
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			const [, name = "", file] =
				/^\/((?:@[^/]+\/)?[^/]+)(?:\/-\/(.+))?$/.exec(
					decodeURIComponent(url.pathname),
				) ?? [];
			const versions = packages[name];
			if (!versions) return new Response("{}", { status: 404 });
			if (file) {
				const version = file.slice(short(name).length + 1, -".tgz".length);
				const bytes = tarballs.get(`${name}@${version}`);
				return bytes ? new Response(bytes) : new Response("", { status: 404 });
			}
			const entries = versions.map((version) => {
				const bytes = tarballs.get(`${name}@${version}`) as Uint8Array;
				const sha512 = createHash("sha512").update(bytes).digest("base64");
				return [
					version,
					{
						name,
						version,
						dist: {
							tarball: `${url.origin}/${name}/-/${short(name)}-${version}.tgz`,
							integrity: `sha512-${sha512}`,
							shasum: createHash("sha1").update(bytes).digest("hex"),
						},
					},
				];
			});
			return Response.json({
				name,
				"dist-tags": { latest: versions.at(-1) },
				versions: Object.fromEntries(entries),
			});
		},
	});
	return {
		url: server.url.href,
		cache: join(folder, "cache"),
		tarball: (name: string, version: string) =>
			join(folder, name, `${version}.tgz`),
		async stop() {
			await server.stop(true);
			await rm(folder, { recursive: true, force: true });
		},
	};
}
