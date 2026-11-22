import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import { run } from "../run";
import { isCompiled } from "../update";
import { LocalCiError, makeCache, type WatchPaths } from "./cache";

const xml = (text: string) =>
	text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const specifiers = (text: string) => text.replaceAll("%", "%%");
const quote = (text: string) => JSON.stringify(specifiers(text));

const watchArgs = () => [
	process.execPath,
	...(isCompiled(Bun.main) ? [] : [Bun.main]),
	"ci",
	"--watch",
];

const fileContents = (file: string) =>
	existsSync(file) ? readFileSync(file, "utf8") : null;

function launchAgent(
	paths: WatchPaths,
	root: string,
	argv: string[],
	path: string,
) {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${paths.label}</string>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>ProgramArguments</key>
  <array>
${argv.map((arg) => `    <string>${xml(arg)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(path)}</string></dict>
  <key>StartInterval</key><integer>300</integer>
  <key>StandardOutPath</key><string>${xml(paths.log)}</string>
  <key>StandardErrorPath</key><string>${xml(paths.log)}</string>
</dict>
</plist>
`;
}

function systemdService(
	paths: WatchPaths,
	root: string,
	argv: string[],
	path: string,
) {
	return `[Unit]
Description=cagr local CI

[Service]
Type=oneshot
WorkingDirectory=${specifiers(root)}
Environment=${quote(`PATH=${path}`)}
ExecStart=:${argv.map(quote).join(" ")}
StandardOutput=append:${specifiers(paths.log)}
StandardError=inherit
`;
}

const systemdTimer = `[Unit]
Description=Check open pull requests every five minutes

[Timer]
OnCalendar=*:0/5
AccuracySec=1s

[Install]
WantedBy=timers.target
`;

function manager(platform: string, execute: typeof run, root: string) {
	return (...args: string[]) =>
		execute(
			platform === "darwin"
				? ["launchctl", ...args]
				: ["systemctl", "--user", ...args],
			root,
			{ timeoutMs: 30_000 },
		);
}

export async function watchInstalled(
	paths: WatchPaths,
	root: string,
	platform = process.platform,
	execute = run,
	uid = process.getuid?.(),
) {
	const command = manager(platform, execute, root);
	if (platform === "darwin" && existsSync(paths.plist))
		return (await command("print", `gui/${uid}/${paths.label}`)).ok;
	if (
		platform === "linux" &&
		existsSync(paths.service) &&
		existsSync(paths.timer)
	) {
		const timer = basename(paths.timer);
		return (
			(await command("is-enabled", timer)).ok &&
			(await command("is-active", timer)).ok
		);
	}
	return false;
}

export async function configureWatch(
	paths: WatchPaths,
	root: string,
	install: boolean,
	{
		platform = process.platform,
		execute = run,
		argv = watchArgs(),
		path = process.env.PATH ?? "/usr/bin:/bin",
		uid = process.getuid?.(),
	} = {},
) {
	if (platform !== "darwin" && platform !== "linux")
		throw new LocalCiError(
			"Automatic scheduling needs launchd or systemd. Run cagr ci --watch manually.",
		);
	const command = manager(platform, execute, root);
	const checked = async (...args: string[]) => {
		const result = await command(...args);
		if (!result.ok)
			throw new LocalCiError(
				`${args.join(" ")} failed. Run from your logged-in user session and retry.\n${result.output.trim()}`,
			);
	};
	if (install) makeCache(paths.cache);
	if (platform === "darwin") {
		const domain = `gui/${uid}`;
		const target = `${domain}/${paths.label}`;
		const current = fileContents(paths.plist);
		const loaded = (await command("print", target)).ok;
		if (install) {
			const desired = launchAgent(paths, root, argv, path);
			if (loaded && current === desired) return;
			if (loaded) await checked("bootout", target);
			mkdirSync(dirname(paths.plist), { recursive: true });
			writeFileSync(paths.plist, desired);
			await checked("bootstrap", domain, paths.plist);
		} else {
			if (loaded) await checked("bootout", target);
			rmSync(paths.plist, { force: true });
		}
		return;
	}
	const service = basename(paths.service);
	const timer = basename(paths.timer);
	if (install) {
		if ([root, paths.log, path, ...argv].some((arg) => /[\r\n]/.test(arg)))
			throw new LocalCiError(
				"Use a checkout, cache and PATH without newlines to install the systemd timer.",
			);
		const desired = systemdService(paths, root, argv, path);
		const changed =
			fileContents(paths.service) !== desired ||
			fileContents(paths.timer) !== systemdTimer;
		if (changed) {
			mkdirSync(dirname(paths.service), { recursive: true });
			writeFileSync(paths.service, desired);
			writeFileSync(paths.timer, systemdTimer);
		}
		// Reload even if the files match: the previous install may have failed before loading them.
		await checked("daemon-reload");
		await checked("enable", "--now", timer);
	} else if (existsSync(paths.timer) || existsSync(paths.service)) {
		await checked("disable", "--now", timer);
		await checked("stop", service);
		rmSync(paths.timer, { force: true });
		rmSync(paths.service, { force: true });
		await checked("daemon-reload");
	}
}
