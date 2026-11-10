export type FindingTool = "eslint" | "ruff";
export type FindingCommand = { tool: FindingTool; argv: string[] };

/** Only literal argv with one changed-file placeholder can be compared safely. */
export function findingCommand(command: string): FindingCommand | null {
	if (!/^[\w\s@/.,={}:-]+$/.test(command)) return null;
	const words = command.trim().split(/\s+/);
	if (words.filter((word) => word === "{files}").length !== 1) return null;
	if (words[0] === "bunx" || words[0] === "npx" || words[0] === "uvx")
		words.shift();
	else if (
		(words[0] === "pnpm" && words[1] === "exec") ||
		(words[0] === "uv" && words[1] === "run")
	)
		words.splice(0, 2);
	const tool = words.shift();
	if (tool !== "eslint" && tool !== "ruff") return null;
	if (tool === "ruff" && words.shift() !== "check") return null;
	const flags =
		tool === "eslint"
			? ["--fix", "--quiet", "--no-ignore", "--no-warn-ignored"]
			: ["--fix", "--unsafe-fixes", "--no-cache"];
	const valued =
		tool === "eslint"
			? ["--max-warnings"]
			: [
					"--select",
					"--ignore",
					"--extend-select",
					"--extend-ignore",
					"--target-version",
				];
	const args: string[] = [];
	for (let i = 0; i < words.length; i++) {
		const word = words[i] as string;
		if (word === "{files}") continue;
		if (flags.includes(word)) {
			if (word !== "--fix" && word !== "--unsafe-fixes") args.push(word);
			continue;
		}
		const [flag, inline] = word.split("=");
		if (!valued.includes(flag as string)) return null;
		const value = inline ?? words[++i];
		if (!value || !/^[\w,.-]+$/.test(value)) return null;
		args.push(flag as string, value);
	}
	// Launchers are retained, including their local executable resolution.
	const prefix = command
		.trim()
		.split(/\s+/)
		.slice(0, command.trim().split(/\s+/).indexOf(tool) + 1);
	return {
		tool,
		argv: [...prefix, ...(tool === "ruff" ? ["check"] : []), ...args],
	};
}
