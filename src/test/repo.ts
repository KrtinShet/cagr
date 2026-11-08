import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { run } from "../run";

/** A throwaway git repo on main with one commit. */
export async function tempRepo(prefix = "gw-repo-") {
	const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
	const git = async (...args: string[]) => {
		const result = await run(["git", ...args], root);
		if (!result.ok) throw new Error(`git ${args.join(" ")}: ${result.output}`);
		return result.output.trim();
	};
	const write = async (path: string, text: string) => {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), text);
	};
	const commit = async (message: string, files: Record<string, string>) => {
		for (const [path, text] of Object.entries(files)) await write(path, text);
		await git("add", "-A");
		await git("commit", "-q", "-m", message);
		return git("rev-parse", "HEAD");
	};
	await git("init", "-q", "-b", "main");
	await git("config", "user.email", "test@example.com");
	await git("config", "user.name", "Test");
	await git("config", "commit.gpgsign", "false");
	await commit("chore: start", { "README.md": "hello\n" });
	return { root, git, write, commit };
}
