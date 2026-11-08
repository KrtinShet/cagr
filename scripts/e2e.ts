// End to end check of the compiled binary on fresh TypeScript and Python projects.
// Runs `init`, then calls each hook the way the generated agent and git hook files do.
// Usage: bun scripts/e2e.ts [path to binary]   (default: dist/<host binary>)
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binaryName, targets } from "./targets";

const host = targets.find(
	(t) =>
		t.platform === process.platform && t.arch === process.arch && t.libc === "",
);
if (!host)
	throw new Error(`No binary for ${process.platform} ${process.arch}.`);
const binary =
	process.argv[2] ?? join(import.meta.dir, "..", "dist", binaryName(host));

const work = mkdtempSync(join(tmpdir(), "guardwright-e2e-"));
const bin = join(work, "bin");
mkdirSync(bin);
copyFileSync(binary, join(bin, "guardwright"));
Bun.spawnSync(["chmod", "755", join(bin, "guardwright")]);
const env = {
	...process.env,
	PATH: `${bin}:${process.env.PATH}`,
	GIT_CONFIG_GLOBAL: join(work, "gitconfig"),
};
writeFileSync(
	env.GIT_CONFIG_GLOBAL,
	"[user]\n\tname = e2e\n\temail = e2e@example.com\n[init]\n\tdefaultBranch = main\n",
);

let failures = 0;
const session = `e2e-${Date.now()}`;

function run(
	cmd: string[],
	cwd: string,
	input?: string,
	extra: Record<string, string> = {},
) {
	const result = Bun.spawnSync(cmd, {
		cwd,
		env: { ...env, ...extra },
		stdin: input === undefined ? "ignore" : Buffer.from(input),
	});
	return {
		code: result.exitCode,
		out: result.stdout.toString(),
		err: result.stderr.toString(),
	};
}

function sh(script: string, cwd: string) {
	const result = run(["sh", "-c", script], cwd);
	if (result.code !== 0)
		throw new Error(`${script} failed:\n${result.out}${result.err}`);
	return result.out;
}

function title(text: string) {
	console.log(`\n=== ${text} ===`);
}

function expect(label: string, ok: boolean, shown: string) {
	if (!ok) failures++;
	console.log(`\n${ok ? "PASS" : "FAIL"}  ${label}`);
	const text = shown.trim();
	if (text)
		console.log(
			text.length > 1500
				? `${text.slice(0, 1500)}\n...`
				: text.replace(/^/gm, "      "),
		);
}

type Kind = "allow" | "context" | "deny" | "block" | "notice";

function kindOf(out: string): Kind {
	if (out.trim() === "") return "allow";
	try {
		const parsed = JSON.parse(out);
		if (parsed.hookSpecificOutput?.permissionDecision === "deny") return "deny";
		if (parsed.decision === "block") return "block";
		if (parsed.systemMessage) return "notice";
	} catch {}
	return "context";
}

/** Calls a hook through the command the agent's generated hook file holds. */
function hook(
	project: string,
	agent: "claude" | "codex",
	native: string,
	payload: Record<string, unknown>,
	want: Kind,
	label: string,
) {
	const file =
		agent === "claude" ? ".claude/settings.json" : ".codex/hooks.json";
	const groups = JSON.parse(readFileSync(join(project, file), "utf8")).hooks[
		native
	] as { matcher?: string; hooks: { command: string }[] }[];
	const tool = payload.tool_name as string | undefined;
	const group = groups.find(
		(g) =>
			!g.matcher ||
			(tool !== undefined && new RegExp(`^(${g.matcher})$`).test(tool)),
	);
	const command = group?.hooks.find((h) =>
		h.command.includes("guardwright"),
	)?.command;
	if (!command)
		throw new Error(
			`No guardwright hook for ${native} ${tool ?? ""} in ${file}.`,
		);
	const input = JSON.stringify({
		session_id: `${session}-${project.split("/").at(-1)}-${agent}`,
		cwd: project,
		hook_event_name: native,
		...payload,
	});
	const started = performance.now();
	const result = run(["sh", "-c", command], project, input, {
		CLAUDE_PROJECT_DIR: project,
	});
	const ms = Math.round(performance.now() - started);
	const got = kindOf(result.out);
	expect(
		`${agent} ${native}${tool ? ` ${tool}` : ""}: ${label} -> ${want} (got ${got}, ${ms}ms)`,
		got === want && result.code === 0,
		result.out + result.err,
	);
	return result.out;
}

const bash = (command: string) => ({
	tool_name: "Bash",
	tool_input: { command },
});
const write = (project: string, path: string, content: string) => {
	writeFileSync(join(project, path), content);
	return {
		tool_name: "Write",
		tool_input: { file_path: join(project, path), content },
	};
};

function gitChecks(project: string) {
	title(`${project}: git hooks`);
	sh("git add -A", project);
	const bad = run(["git", "commit", "-q", "-m", "fixed stuff"], project);
	expect("commit-msg blocks `fixed stuff`", bad.code !== 0, bad.err);
	const good = run(
		["git", "commit", "-q", "-m", "chore: start the project"],
		project,
	);
	expect(
		"commit-msg allows `chore: start the project`",
		good.code === 0,
		good.err,
	);
	const remote = join(work, `${project.split("/").at(-1)}-remote.git`);
	sh(
		`git init -q --bare ${remote} && git remote add origin ${remote}`,
		project,
	);
	const toMain = run(["git", "push", "-q", "origin", "main"], project);
	expect(
		"pre-push blocks a push to main",
		toMain.code !== 0 && /main/.test(toMain.err),
		toMain.err,
	);
	sh("git switch -q -c wip", project);
	const badName = run(["git", "push", "-q", "origin", "wip"], project);
	expect(
		"pre-push blocks branch `wip` (not type/name)",
		badName.code !== 0,
		badName.err,
	);
	sh("git branch -q -m wip feat/start", project);
	const ok = run(["git", "push", "-q", "origin", "feat/start"], project);
	expect("pre-push allows `feat/start`", ok.code === 0, ok.err);
	const skip = run(
		["git", "push", "-q", "origin", "HEAD:main"],
		project,
		undefined,
		{ GUARDWRIGHT_SKIP: "1" },
	);
	expect(
		"a human can skip once with GUARDWRIGHT_SKIP=1",
		skip.code === 0,
		skip.err,
	);
}

function initAndDoctor(project: string) {
	const init = run(["guardwright", "init"], project);
	expect("guardwright init", init.code === 0, init.out + init.err);
	const check = run(["guardwright", "sync", "--check"], project);
	expect("guardwright sync --check", check.code === 0, check.out + check.err);
}

function doctor(project: string) {
	const result = run(["guardwright", "doctor"], project);
	expect("guardwright doctor", result.code === 0, result.out + result.err);
}

// TypeScript
{
	const project = join(work, "ts-app");
	mkdirSync(project);
	title("TypeScript project");
	sh(
		"git init -q && bun init -y >/dev/null && bun add -d @biomejs/biome@2.6.6 typescript >/dev/null 2>&1",
		project,
	);
	sh(`bunx biome init >/dev/null`, project);
	const pkg = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
	pkg.scripts = { lint: "biome check .", typecheck: "tsc --noEmit" };
	writeFileSync(join(project, "package.json"), JSON.stringify(pkg, null, 2));
	writeFileSync(join(project, ".env"), "API_KEY=secret\n");
	writeFileSync(join(project, ".gitignore"), "node_modules\n.env\n");
	sh("bunx biome check --write . >/dev/null", project);
	initAndDoctor(project);
	writeFileSync(
		join(project, "guardwright.toml"),
		`${readFileSync(join(project, "guardwright.toml"), "utf8")}\n[commands]\nblocked = [{ match = "prisma db push", reason = "Use \`bun run db:migrate --name <change>\`." }]\n`,
	);
	mkdirSync(join(project, ".guardwright/rules"), { recursive: true });
	writeFileSync(
		join(project, ".guardwright/rules/no-console-log.yml"),
		[
			"id: no-console-log",
			"language: typescript",
			"message: console.log($$$ARGS) leaves debug output in app code.",
			"instead: Use `logger.info` from src/logger.ts.",
			"rule:",
			"  pattern: console.log($$$ARGS)",
			"examples:",
			"  invalid: ['console.log(\"hi\")']",
			"  valid: ['logger.info(\"hi\")']",
			"",
		].join("\n"),
	);
	const rulesTest = run(["guardwright", "rules", "test"], project);
	expect(
		"guardwright rules test",
		rulesTest.code === 0,
		rulesTest.out + rulesTest.err,
	);

	title("TypeScript: agent hooks (Claude Code)");
	hook(
		project,
		"claude",
		"SessionStart",
		{ source: "startup" },
		"context",
		"brief",
	);
	hook(
		project,
		"claude",
		"PreToolUse",
		bash("npm install zod"),
		"deny",
		"wrong package manager",
	);
	hook(
		project,
		"claude",
		"PreToolUse",
		bash("git push origin main"),
		"deny",
		"push to main",
	);
	hook(
		project,
		"claude",
		"PreToolUse",
		bash("git push --force origin feat/x"),
		"deny",
		"force push",
	);
	hook(
		project,
		"claude",
		"PreToolUse",
		bash("git commit --no-verify -m 'feat: x'"),
		"deny",
		"hook skip",
	);
	hook(
		project,
		"claude",
		"PreToolUse",
		bash("bunx prisma db push"),
		"deny",
		"blocked command",
	);
	hook(
		project,
		"claude",
		"PreToolUse",
		bash("bun add zod && bun test"),
		"allow",
		"bun",
	);
	hook(
		project,
		"claude",
		"PreToolUse",
		{
			tool_name: "Edit",
			tool_input: {
				file_path: join(project, ".env"),
				old_string: "a",
				new_string: "b",
			},
		},
		"deny",
		"edit .env",
	);
	hook(
		project,
		"claude",
		"PreToolUse",
		{
			tool_name: "Write",
			tool_input: { file_path: join(project, "index.ts"), content: "" },
		},
		"allow",
		"edit index.ts",
	);
	hook(
		project,
		"claude",
		"PostToolUse",
		write(
			project,
			"index.ts",
			'export const isTwo = (n: number) => n == 2;\nconsole.log("hi");\n',
		),
		"block",
		"== and console.log",
	);
	hook(
		project,
		"claude",
		"PostToolUse",
		write(
			project,
			"index.ts",
			'export const isTwo = (n: number) => n === 2;\nexport const count: number = "one";\n',
		),
		"allow",
		"lint clean (type error left for turn end)",
	);
	hook(
		project,
		"claude",
		"Stop",
		{ stop_hook_active: false },
		"block",
		"tsc fails",
	);
	hook(
		project,
		"claude",
		"Stop",
		{ stop_hook_active: true },
		"block",
		"tsc still fails",
	);
	hook(
		project,
		"claude",
		"Stop",
		{ stop_hook_active: true },
		"notice",
		"third failed stop: let go, tell the human",
	);
	hook(
		project,
		"claude",
		"PostToolUse",
		write(
			project,
			"index.ts",
			"export const isTwo = (n: number) => n === 2;\nexport const count = 1;\n",
		),
		"allow",
		"fixed",
	);
	hook(
		project,
		"claude",
		"Stop",
		{ stop_hook_active: false },
		"allow",
		"all checks pass",
	);
	hook(
		project,
		"claude",
		"Stop",
		{ stop_hook_active: false },
		"allow",
		"nothing changed since",
	);

	title("TypeScript: agent hooks (Codex)");
	hook(
		project,
		"codex",
		"SessionStart",
		{ source: "startup" },
		"context",
		"brief",
	);
	hook(
		project,
		"codex",
		"PreToolUse",
		{ tool_name: "Bash", tool_input: { command: ["bash", "-lc", "npx tsc"] } },
		"deny",
		"npx via argv",
	);
	hook(
		project,
		"codex",
		"PreToolUse",
		{
			tool_name: "apply_patch",
			tool_input: {
				command: [
					"apply_patch",
					"*** Begin Patch\n*** Update File: .env\n@@\n-A=1\n+A=2\n*** End Patch\n",
				],
			},
		},
		"deny",
		"patch .env",
	);
	hook(project, "codex", "PreToolUse", bash("bun run lint"), "allow", "bun");

	const checkCmd = run(["guardwright", "check", "index.ts"], project);
	expect(
		"guardwright check index.ts",
		checkCmd.code === 0,
		checkCmd.out + checkCmd.err,
	);
	doctor(project);
	gitChecks(project);
	reviewGate(project);
}

/** The review gate end to end, with a scripted reviewer in place of a model. */
function reviewGate(project: string) {
	title("TypeScript: review gate");
	const reviewer = join(work, "fake-reviewer.sh");
	// Finders get a schema with "findings"; verifiers confirm every candidate.
	writeFileSync(
		reviewer,
		`if grep -q '"findings"' "$1"; then
  echo '{"summary":"1 important.","findings":[{"severity":"important","category":"bug","file":"guardwright.toml","line":1,"title":"The reviewer is a script","detail":"","bug_class":""}],"fixed":[]}'
else
  echo '{"candidates":[{"id":"C1","real":true,"severity":"important","reason":"yes"}],"previous":[]}'
fi
`,
	);
	writeFileSync(
		join(project, "guardwright.toml"),
		`${readFileSync(join(project, "guardwright.toml"), "utf8")}\n[review]\nreviewer = "sh ${reviewer} {schema_file}"\n`,
	);
	sh("git commit -qam 'chore: use a scripted reviewer'", project);
	const body =
		"## Testing\nbun test\n## Risk\nlow\n## How to revert\ngit revert";
	const create = `gh pr create -t "feat: start" --body "${body}"`;
	hook(project, "claude", "PreToolUse", bash(create), "deny", "no review yet");
	hook(
		project,
		"claude",
		"PreToolUse",
		bash("gh pr create --fill"),
		"deny",
		"--fill has no sections",
	);
	hook(
		project,
		"claude",
		"PreToolUse",
		bash("gh pr merge 1 --squash"),
		"deny",
		"agents do not merge",
	);
	const first = run(["guardwright", "review"], project);
	expect(
		"guardwright review finds an Important problem and exits 1",
		first.code === 1 && first.out.includes("f1 guardwright.toml:1"),
		first.out + first.err,
	);
	const denied = hook(
		project,
		"claude",
		"PreToolUse",
		bash(create),
		"deny",
		"f1 is open",
	);
	expect(
		"the denial names f1 and how to answer it",
		denied.includes("f1 guardwright.toml:1") &&
			denied.includes("guardwright review answer f1"),
		"",
	);
	const answer = run(
		[
			"guardwright",
			"review",
			"answer",
			"f1",
			"--intentional",
			"the e2e run uses a script on purpose",
		],
		project,
	);
	expect(
		"guardwright review answer f1",
		answer.code === 0,
		answer.out + answer.err,
	);
	hook(project, "claude", "PreToolUse", bash(create), "allow", "f1 answered");
	sh("git commit -q --allow-empty -m 'chore: one more commit'", project);
	hook(
		project,
		"claude",
		"PreToolUse",
		bash(create),
		"deny",
		"a commit after the review",
	);
	const status = run(["guardwright", "review", "status"], project);
	expect(
		"guardwright review status",
		status.code === 0 && status.out.includes("before your latest commit"),
		status.out + status.err,
	);
}

// Python
{
	const project = join(work, "py-app");
	mkdirSync(project);
	title("Python project");
	sh(
		"git init -q && uv init -q --name py-app --lib . && uv add -q --dev ruff pytest",
		project,
	);
	writeFileSync(join(project, ".gitignore"), ".venv\n__pycache__\n");
	mkdirSync(join(project, "tests"));
	writeFileSync(
		join(project, "tests/test_app.py"),
		"from py_app import double\n\n\ndef test_double():\n    assert double(2) == 4\n",
	);
	writeFileSync(
		join(project, "src/py_app/__init__.py"),
		"def double(n: int) -> int:\n    return n * 2\n",
	);
	initAndDoctor(project);
	mkdirSync(join(project, ".guardwright/rules"), { recursive: true });
	writeFileSync(
		join(project, ".guardwright/rules/no-print.yml"),
		[
			"id: no-print",
			"language: python",
			"message: print($$$ARGS) in library code.",
			"instead: Use `logging.getLogger(__name__)`.",
			"files: ['src/**']",
			"rule:",
			"  pattern: print($$$ARGS)",
			"examples:",
			"  invalid: [\"print('x')\"]",
			"  valid: [\"log.info('x')\"]",
			"",
		].join("\n"),
	);

	title("Python: agent hooks (Claude Code)");
	const lib = "src/py_app/__init__.py";
	hook(
		project,
		"claude",
		"SessionStart",
		{ source: "startup" },
		"context",
		"brief",
	);
	hook(
		project,
		"claude",
		"PreToolUse",
		bash("pip install requests"),
		"deny",
		"pip",
	);
	hook(
		project,
		"claude",
		"PreToolUse",
		bash("python -m pip install requests"),
		"deny",
		"python -m pip",
	);
	hook(project, "claude", "PreToolUse", bash("uv add requests"), "allow", "uv");
	hook(
		project,
		"claude",
		"PreToolUse",
		{
			tool_name: "Edit",
			tool_input: {
				file_path: join(project, "uv.lock"),
				old_string: "a",
				new_string: "b",
			},
		},
		"deny",
		"edit uv.lock",
	);
	hook(
		project,
		"claude",
		"PostToolUse",
		write(
			project,
			lib,
			"def double(n: int) -> int:\n    print(n)\n    return n * 2 + missing\n",
		),
		"block",
		"undefined name and print",
	);
	hook(
		project,
		"claude",
		"PostToolUse",
		write(project, lib, "def double(n: int) -> int:\n    return n * 3\n"),
		"allow",
		"clean, but the test now fails",
	);
	hook(
		project,
		"claude",
		"Stop",
		{ stop_hook_active: false },
		"block",
		"pytest fails",
	);
	hook(
		project,
		"claude",
		"PostToolUse",
		write(project, lib, "def double(n: int) -> int:\n    return n * 2\n"),
		"allow",
		"fixed",
	);
	hook(
		project,
		"claude",
		"Stop",
		{ stop_hook_active: true },
		"allow",
		"pytest passes",
	);
	doctor(project);
	gitChecks(project);
}

if (failures === 0) rmSync(work, { recursive: true, force: true });
else console.log(`\nKept ${work} for a look.`);
console.log(
	`\n${failures === 0 ? "All end to end checks passed." : `${failures} end to end check(s) failed.`}`,
);
process.exit(failures === 0 ? 0 : 1);
