// Lays out what each channel publishes, from the binaries in dist/. Nothing is published.
//   dist/npm/      the `guardwright` wrapper and one @guardwright/cli-* package per platform
//   dist/wheels/   one py3-none-<platform> wheel per platform, binary in .data/scripts
//   dist/release/  the bare binaries, SHA256SUMS and install.sh, for a GitHub release
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { version } from "../src/version";
import { binaryName, type Target, targets } from "./targets";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const description =
	"One config for every coding agent's guardrails: commands, files, git, and code rules.";
const license = "MIT";

const npmOs = (target: Target) =>
	target.platform === "win32" ? "windows" : target.platform;
const npmName = (target: Target) =>
	`@guardwright/cli-${npmOs(target)}-${target.arch}${target.libc ? `-${target.libc}` : ""}`;
const wheelTag: Record<string, string> = {
	"darwin-arm64-": "macosx_11_0_arm64",
	"darwin-x64-": "macosx_10_15_x86_64",
	"linux-x64-": "manylinux_2_28_x86_64",
	"linux-arm64-": "manylinux_2_28_aarch64",
	"linux-x64-musl": "musllinux_1_2_x86_64",
	"linux-arm64-musl": "musllinux_1_2_aarch64",
	"win32-x64-": "win_amd64",
};

const built = targets.filter((target) =>
	existsSync(join(dist, binaryName(target))),
);
if (built.length === 0)
	throw new Error("No binaries in dist/. Run `bun run build` first.");
for (const dir of ["npm", "wheels", "release"])
	rmSync(join(dist, dir), { recursive: true, force: true });

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

// npm
const wrapper = join(dist, "npm", "guardwright");
mkdirSync(join(wrapper, "bin"), { recursive: true });
copyFileSync(
	join(root, "packaging/npm/guardwright.js"),
	join(wrapper, "bin/guardwright.js"),
);
writeFileSync(
	join(wrapper, "package.json"),
	json({
		name: "guardwright",
		version,
		description,
		license,
		bin: { guardwright: "bin/guardwright.js" },
		files: ["bin"],
		optionalDependencies: Object.fromEntries(
			built.map((target) => [npmName(target), version]),
		),
	}),
);
for (const target of built) {
	const dir = join(dist, "npm", npmName(target).replace("@guardwright/", ""));
	const exe = target.platform === "win32" ? "guardwright.exe" : "guardwright";
	mkdirSync(dir, { recursive: true });
	copyFileSync(join(dist, binaryName(target)), join(dir, exe));
	chmodSync(join(dir, exe), 0o755);
	writeFileSync(
		join(dir, "package.json"),
		json({
			name: npmName(target),
			version,
			description: `The guardwright binary for ${npmOs(target)} ${target.arch}${target.libc ? ` ${target.libc}` : ""}.`,
			license,
			os: [target.platform],
			cpu: [target.arch],
			...(target.platform === "linux"
				? { libc: [target.libc || "glibc"] }
				: {}),
			files: [exe],
		}),
	);
}

// Wheels
const sha256 = (data: Uint8Array<ArrayBuffer>) =>
	new Bun.CryptoHasher("sha256").update(data).digest("base64url");
mkdirSync(join(dist, "wheels"), { recursive: true });
for (const target of built) {
	const tag = wheelTag[
		`${target.platform}-${target.arch}-${target.libc}`
	] as string;
	const info = `guardwright-${version}.dist-info`;
	const exe = target.platform === "win32" ? "guardwright.exe" : "guardwright";
	const files: [string, Uint8Array<ArrayBuffer>, number][] = [
		[
			`guardwright-${version}.data/scripts/${exe}`,
			new Uint8Array(readFileSync(join(dist, binaryName(target)))),
			0o755,
		],
		[
			`${info}/METADATA`,
			text(
				`Metadata-Version: 2.1\nName: guardwright\nVersion: ${version}\nSummary: ${description}\nLicense: ${license}\nRequires-Python: >=3.8\n`,
			),
			0o644,
		],
		[
			`${info}/WHEEL`,
			text(
				`Wheel-Version: 1.0\nGenerator: guardwright scripts/package.ts\nRoot-Is-Purelib: false\nTag: py3-none-${tag}\n`,
			),
			0o644,
		],
	];
	const record = [
		...files.map(
			([path, data]) => `${path},sha256=${sha256(data)},${data.length}`,
		),
		`${info}/RECORD,,`,
	].join("\n");
	files.push([`${info}/RECORD`, text(`${record}\n`), 0o644]);
	writeFileSync(
		join(dist, "wheels", `guardwright-${version}-py3-none-${tag}.whl`),
		zip(files),
	);
}

// Release assets
const release = join(dist, "release");
mkdirSync(release, { recursive: true });
const sums: string[] = [];
for (const target of built) {
	const name = binaryName(target);
	const data = readFileSync(join(dist, name));
	copyFileSync(join(dist, name), join(release, name));
	sums.push(
		`${new Bun.CryptoHasher("sha256").update(data).digest("hex")}  ${name}`,
	);
}
writeFileSync(join(release, "SHA256SUMS"), `${sums.join("\n")}\n`);
copyFileSync(join(root, "packaging/install.sh"), join(release, "install.sh"));
console.log(
	`Packaged ${built.length} platforms into dist/npm, dist/wheels and dist/release.`,
);

function text(value: string) {
	return new TextEncoder().encode(value);
}

/** A zip archive with deflated entries: enough for a wheel. */
function zip(entries: [string, Uint8Array<ArrayBuffer>, number][]): Uint8Array {
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	const central: Uint8Array<ArrayBuffer>[] = [];
	let offset = 0;
	for (const [path, data, mode] of entries) {
		const name = text(path);
		const packed = Bun.deflateSync(data);
		const crc = Bun.hash.crc32(data);
		const local = new DataView(new ArrayBuffer(30));
		local.setUint32(0, 0x04034b50, true);
		local.setUint16(4, 20, true);
		local.setUint16(8, 8, true);
		local.setUint32(14, crc, true);
		local.setUint32(18, packed.length, true);
		local.setUint32(22, data.length, true);
		local.setUint16(26, name.length, true);
		chunks.push(new Uint8Array(local.buffer), name, packed);
		const entry = new DataView(new ArrayBuffer(46));
		entry.setUint32(0, 0x02014b50, true);
		entry.setUint16(4, (3 << 8) | 20, true);
		entry.setUint16(6, 20, true);
		entry.setUint16(10, 8, true);
		entry.setUint32(16, crc, true);
		entry.setUint32(20, packed.length, true);
		entry.setUint32(24, data.length, true);
		entry.setUint16(28, name.length, true);
		entry.setUint32(38, ((0o100000 | mode) << 16) >>> 0, true);
		entry.setUint32(42, offset, true);
		central.push(new Uint8Array(entry.buffer), name);
		offset += 30 + name.length + packed.length;
	}
	const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
	const end = new DataView(new ArrayBuffer(22));
	end.setUint32(0, 0x06054b50, true);
	end.setUint16(8, entries.length, true);
	end.setUint16(10, entries.length, true);
	end.setUint32(12, centralSize, true);
	end.setUint32(16, offset, true);
	return Buffer.concat([...chunks, ...central, new Uint8Array(end.buffer)]);
}
