import { expect, test } from "bun:test";
import { githubLines } from "./doctor-github";
import type { Gh } from "./review/github";
import { config } from "./test/config";

const gh =
	(responses: Record<string, unknown>): Gh =>
	async (args) => {
		if (args[0] === "repo") return "o/r\n";
		const value = responses[args[1] ?? ""];
		if (value === undefined) throw new Error("HTTP 404");
		return JSON.stringify(value);
	};

const settings = config({
	extends: ["recommended"],
	ci: { github: true, review: true },
	risk: {
		paths: [{ glob: "src/auth/**", tier: "high", owners: ["@org/sec"] }],
	},
});

test("no protection at all is one failing line with where to set it", async () => {
	const lines = await githubLines(settings, gh({}));
	expect(lines).toHaveLength(1);
	expect(lines[0]?.ok).toBe(false);
	expect(lines[0]?.text).toContain("has no branch protection or ruleset");
	expect(lines[0]?.text).toContain("https://github.com/o/r/settings/rules");
});

test("classic protection and rulesets combine", async () => {
	const lines = await githubLines(
		settings,
		gh({
			"repos/o/r/branches/main/protection": {
				required_pull_request_reviews: { required_approving_review_count: 1 },
				required_status_checks: { contexts: ["checks"] },
			},
			"repos/o/r/rules/branches/main": [
				{
					type: "pull_request",
					parameters: {
						dismiss_stale_reviews_on_push: true,
						required_review_thread_resolution: true,
					},
				},
				{
					type: "required_status_checks",
					parameters: { required_status_checks: [{ context: "review" }] },
				},
			],
		}),
	);
	const failing = lines.filter((line) => !line.ok).map((line) => line.text);
	expect(failing).toHaveLength(1);
	expect(failing[0]).toContain("Require review from Code Owners");
	expect(lines.map((line) => line.text)).toContain("main needs 1 approval.");
});

test("a missing gh login says how to fix it", async () => {
	const broken: Gh = async () => {
		throw new Error("not logged in");
	};
	const lines = await githubLines(settings, broken);
	expect(lines[0]?.text).toContain("gh auth login");
});
