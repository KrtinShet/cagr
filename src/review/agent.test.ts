import { expect, test } from "bun:test";
import {
	claudeResult,
	commandAgent,
	parseJson,
	pickAgent,
	ReviewerError,
} from "./agent";

test("claudeResult finds the result in one object or a list of events", () => {
	const result = { type: "result", structured_output: { ok: 1 } };
	expect(claudeResult(JSON.stringify(result))).toEqual(result);
	expect(
		claudeResult(`warning: x\n${JSON.stringify([{ type: "system" }, result])}`),
	).toEqual(result);
	expect(claudeResult("no json here")).toBeNull();
	expect(claudeResult("{broken")).toBeNull();
});

test("parseJson takes plain JSON, a fenced block, or the outer braces", () => {
	expect(parseJson('{"a":1}', "x")).toEqual({ a: 1 });
	expect(parseJson('Here:\n```json\n{"a":2}\n```\n', "x")).toEqual({ a: 2 });
	expect(parseJson('The answer is {"a":3}. Done.', "x")).toEqual({ a: 3 });
	expect(() => parseJson("nothing", "codex")).toThrow(
		"codex did not print JSON",
	);
});

test("auto picks the agent the author runs, then whatever is installed", () => {
	const both = (name: string) => `/bin/${name}`;
	const onlyCodex = (name: string) => (name === "codex" ? "/bin/codex" : null);
	expect(pickAgent("auto", { CLAUDECODE: "1" }, both).name).toBe("claude");
	expect(pickAgent("auto", { CODEX_HOME: "/x" }, both).name).toBe("codex");
	expect(pickAgent("auto", {}, both).name).toBe("claude");
	expect(pickAgent("auto", { CLAUDECODE: "1" }, onlyCodex).name).toBe("codex");
	expect(() => pickAgent("auto", {}, () => null)).toThrow(ReviewerError);
	expect(pickAgent("./my-review.sh {prompt_file}", {}, () => null).name).toBe(
		"./my-review.sh",
	);
});

test("a command reviewer gets the prompt on stdin and in a file, and runs as a reviewer", async () => {
	const agent = commandAgent(
		`cat {prompt_file} >/dev/null && printf '{"seen":"%s","reviewer":"%s"}' "$(cat)" "$GUARDWRIGHT_REVIEWER"`,
	);
	const answer = await agent.ask({
		prompt: "hello",
		schema: {},
		cwd: process.cwd(),
		timeoutMs: 5000,
		model: null,
	});
	expect(answer).toEqual({ seen: "hello", reviewer: "1" });
	const failing = commandAgent("echo nope >&2; exit 3");
	await expect(
		failing.ask({
			prompt: "",
			schema: {},
			cwd: process.cwd(),
			timeoutMs: 5000,
			model: null,
		}),
	).rejects.toThrow("failed: nope");
});
