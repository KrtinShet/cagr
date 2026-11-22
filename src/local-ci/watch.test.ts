import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { run } from "../run";
import { tempRepo } from "../test/repo";
import { watchPaths } from "./cache";
import { configureWatch, watchInstalled } from "./watch";

async function fixture() {
	const repo = await tempRepo("gw repo & 50%-");
	const home = mkdtempSync(join(tmpdir(), "gw-watch-"));
	const paths = await watchPaths(repo.root, home, join(home, "config"));
	if (!paths) throw new Error("Test repo is missing");
	const calls: string[][] = [];
	let loaded = false;
	const execute: typeof run = async (argv) => {
		calls.push(argv);
		if (argv.includes("bootstrap") || argv.includes("enable")) loaded = true;
		if (argv.includes("bootout") || argv.includes("disable")) loaded = false;
		return {
			ok:
				!argv.some((arg) =>
					["print", "is-enabled", "is-active"].includes(arg),
				) || loaded,
			stdout: "",
			output: "",
			ms: 0,
			timedOut: false,
		};
	};
	return {
		repo,
		paths,
		calls,
		execute,
		clean() {
			rmSync(repo.root, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		},
	};
}

test("launchd installation writes an escaped five-minute agent and unloads it", async () => {
	const f = await fixture();
	const options = {
		platform: "darwin" as const,
		uid: 123,
		execute: f.execute,
		argv: ["/path with spaces/cagr", "ci", "--watch"],
		path: "/bin:/tools&more",
	};
	try {
		await configureWatch(f.paths, f.repo.root, true, options);
		const plist = readFileSync(f.paths.plist, "utf8");
		expect(plist).toContain("<key>StartInterval</key><integer>300</integer>");
		expect(plist).toContain("<string>/path with spaces/cagr</string>");
		expect(plist).toContain("<string>--watch</string>");
		expect(plist).toContain("gw repo &amp; 50%-");
		expect(plist).toContain("<string>/bin:/tools&amp;more</string>");
		expect(plist).toContain(
			`<key>StandardOutPath</key><string>${f.paths.log}</string>`,
		);
		expect(f.calls).toContainEqual([
			"launchctl",
			"bootstrap",
			"gui/123",
			f.paths.plist,
		]);
		expect(
			await watchInstalled(f.paths, f.repo.root, "darwin", f.execute, 123),
		).toBe(true);
		await configureWatch(f.paths, f.repo.root, true, options);
		expect(f.calls.filter((argv) => argv.includes("bootstrap"))).toHaveLength(
			1,
		);
		await configureWatch(f.paths, f.repo.root, false, options);
		expect(f.calls).toContainEqual([
			"launchctl",
			"bootout",
			`gui/123/${f.paths.label}`,
		]);
		expect(existsSync(f.paths.plist)).toBe(false);
	} finally {
		f.clean();
	}
});

test("systemd installation writes a user service and five-minute timer and removes both", async () => {
	const f = await fixture();
	const options = {
		platform: "linux" as const,
		execute: f.execute,
		argv: ["/path with spaces/50%/cagr", "ci", "--watch"],
		path: "/bin:/tools%extra",
	};
	try {
		await configureWatch(f.paths, f.repo.root, true, options);
		await configureWatch(f.paths, f.repo.root, true, options);
		const service = readFileSync(f.paths.service, "utf8");
		expect(service).toContain(
			'ExecStart=:"/path with spaces/50%%/cagr" "ci" "--watch"',
		);
		expect(service).toContain(
			`WorkingDirectory=${f.repo.root.replace("50%", "50%%")}\n`,
		);
		expect(service).toContain('Environment="PATH=/bin:/tools%%extra"');
		expect(service).toContain(`StandardOutput=append:${f.paths.log}`);
		const timer = readFileSync(f.paths.timer, "utf8");
		expect(timer).toContain("OnCalendar=*:0/5");
		expect(timer).toContain("WantedBy=timers.target");
		const unit = `${f.paths.label}.timer`;
		expect(f.calls).toContainEqual([
			"systemctl",
			"--user",
			"enable",
			"--now",
			unit,
		]);
		expect(await watchInstalled(f.paths, f.repo.root, "linux", f.execute)).toBe(
			true,
		);
		await configureWatch(f.paths, f.repo.root, false, options);
		expect(f.calls).toContainEqual([
			"systemctl",
			"--user",
			"disable",
			"--now",
			unit,
		]);
		expect(f.calls).toContainEqual([
			"systemctl",
			"--user",
			"stop",
			`${f.paths.label}.service`,
		]);
		expect(existsSync(f.paths.timer) || existsSync(f.paths.service)).toBe(
			false,
		);
	} finally {
		f.clean();
	}
});
