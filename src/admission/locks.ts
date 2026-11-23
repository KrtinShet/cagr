import { dlopen, FFIType, read } from "bun:ffi";
import { closeSync, openSync } from "node:fs";
import { supportsAdmission } from "./pressure";

const macSymbols = {
	flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
	__error: { args: [], returns: FFIType.ptr },
} as const;
let mac: ReturnType<typeof dlopen<typeof macSymbols>> | undefined;

export function tryLock(path: string): number | null {
	if (!supportsAdmission)
		throw new Error("Memory admission locks are available on macOS and Linux.");
	const fd = openSync(path, "a+", 0o600);
	let locked = false;
	try {
		if (process.platform === "darwin") {
			mac ??= dlopen("/usr/lib/libSystem.B.dylib", macSymbols);
			locked = mac.symbols.flock(fd, 2 | 4) === 0;
			if (!locked) {
				const pointer = mac.symbols.__error();
				const errno = pointer === null ? 0 : read.i32(pointer);
				if (errno !== 35 && errno !== 4)
					throw new Error(
						`flock failed with errno ${errno}. Check the cache filesystem.`,
					);
			}
		} else {
			// flock locks the open file description shared with our descriptor.
			const result = Bun.spawnSync(["flock", "-n", "-E", "75", "0"], {
				stdin: fd,
				stderr: "pipe",
			});
			if (!result.success && result.exitCode !== 75)
				throw new Error(
					`flock failed. Install util-linux and check the cache filesystem. ${result.stderr.toString().trim()}`,
				);
			locked = result.success;
		}
		return locked ? fd : null;
	} finally {
		if (!locked) closeSync(fd);
	}
}
