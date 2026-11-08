import { expect, test } from "bun:test";
import { config } from "../test/config";
import {
	agentApprovalFinding,
	isGateCommand,
	missingSections,
	prBodyFinding,
} from "./github";

const recommended = config({ extends: ["recommended"] });
const open = config({
	extends: ["recommended"],
	review: { agents_may_merge: true },
});

test("agents may not merge or approve when agents_may_merge is off", () => {
	for (const line of [
		"gh pr merge 12 --squash",
		"cd x && gh pr merge",
		"gh pr review 12 --approve",
		"gh pr review -a",
		"gh api -X PUT repos/o/r/pulls/12/merge",
		`gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }'`,
		`gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }'`,
		"gh api repos/o/r/pulls/12/reviews -f event=APPROVE",
	])
		expect(agentApprovalFinding(line, recommended)?.id).toBe("agent-approval");
});

test("reading and commenting stay allowed", () => {
	for (const line of [
		"gh pr view 12",
		"gh pr review 12 --comment -b 'looks off'",
		"gh api repos/o/r/pulls/12/reviews",
		"echo gh pr merge",
		"gh pr list",
	])
		expect(agentApprovalFinding(line, recommended)).toBeNull();
	expect(agentApprovalFinding("gh pr merge 12", open)).toBeNull();
});

test("the gate matches gh pr create and gh pr ready only when review is on", () => {
	expect(isGateCommand("gh pr create --fill", recommended)).toBe(true);
	expect(
		isGateCommand("git push -u origin x && gh pr ready", recommended),
	).toBe(true);
	expect(isGateCommand("gh pr view", recommended)).toBe(false);
	expect(isGateCommand("gh pr create", config())).toBe(false);
});

const none = () => null;

test("gh pr create needs a body with every section heading", () => {
	expect(
		prBodyFinding("gh pr create --fill", recommended, none)?.reason,
	).toContain("--fill writes the body from commits");
	expect(
		prBodyFinding("gh pr create -t x", recommended, none)?.reason,
	).toContain("has no body");
	const partial = prBodyFinding(
		`gh pr create -t x --body "## Testing\nran it"`,
		recommended,
		none,
	);
	expect(partial?.reason).toContain(`lacks "## Risk", "## How to revert"`);
	expect(partial?.reason).toContain("## How to revert");
});

test("a full body passes, including one in a heredoc or a file", () => {
	const heredoc = `gh pr create -t x --body "$(cat <<'EOF'\n## Summary\nx\n## Testing\nbun test\n## Risk\nlow\n## How to revert\ngit revert\nEOF\n)"`;
	expect(prBodyFinding(heredoc, recommended, none)).toBeNull();
	const file = "## Testing\n\n## Risk\n\n### How to revert\n";
	expect(
		prBodyFinding("gh pr create -t x -F body.md", recommended, () => file),
	).toBeNull();
	expect(
		prBodyFinding(
			"gh pr create -t x -F body.md",
			recommended,
			() => "## Testing",
		)?.id,
	).toBe("pr-body");
	expect(prBodyFinding("gh pr create --web", recommended, none)).toBeNull();
	expect(prBodyFinding("gh pr create --fill", config(), none)).toBeNull();
});

test("headings match whatever their case, after a quote, or in a file", () => {
	expect(missingSections('"## testing\n### RISK', ["Testing", "Risk"])).toEqual(
		[],
	);
});

test("missingSections matches headings, not words in the text", () => {
	expect(
		missingSections("We did no testing.\n## Risk\n", ["Testing", "Risk"]),
	).toEqual(["Testing"]);
});
