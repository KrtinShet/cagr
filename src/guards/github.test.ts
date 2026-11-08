import { expect, test } from "bun:test";
import { config } from "../test/config";
import {
	agentApprovalFinding,
	ghWords,
	isGateCommand,
	missingSections,
	prBodyFinding,
	prHeadBranch,
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

test("ghWords drops flags before the subcommand and expands gh's own aliases", () => {
	expect(ghWords(["gh", "-R", "o/r", "pr", "merge", "1"])).toEqual([
		"gh",
		"pr",
		"merge",
		"1",
	]);
	expect(ghWords(["gh", "--repo=o/r", "pr", "new", "--fill"])).toEqual([
		"gh",
		"pr",
		"create",
		"--fill",
	]);
	expect(ghWords(["git", "status"])).toBeNull();
});

test("other spellings of merge, approve and resolve are denied too", () => {
	for (const line of [
		"gh -R o/r pr merge 1",
		"gh --repo o/r pr merge 1",
		"gh pr review 12 --approve=true",
		"gh alias set m 'pr merge'",
		"gh alias set c 'pr create'",
		"gh alias set n 'pr new --fill'",
		"gh alias set --shell r 'gh pr review --approve $1'",
		"gh alias import aliases.yml",
		`gh api graphql -f query='mutation { resolveReviewThread(input:{threadId:"x"}) { thread { id } } }'`,
	])
		expect(agentApprovalFinding(line, recommended)?.id).toBe("agent-approval");
	expect(
		agentApprovalFinding("gh alias set v 'pr view'", recommended),
	).toBeNull();
	expect(agentApprovalFinding("gh alias list", recommended)).toBeNull();
});

test("the gate catches gh pr new, flags before the subcommand, and the API", () => {
	for (const line of [
		"gh pr new -t x --fill",
		"gh -R o/r pr create -t x",
		"gh pr -R o/r ready 3",
		"gh api repos/o/r/pulls -f head=feat/x -f base=main -f title=x",
		"gh api -X POST repos/{owner}/{repo}/pulls --input body.json",
		`gh api graphql -f query='mutation { createPullRequest(input: {}) { pullRequest { id } } }'`,
		`gh api graphql -f query='mutation { markPullRequestReadyForReview(input: {}) { clientMutationId } }'`,
	])
		expect(isGateCommand(line, recommended)).toBe(true);
	for (const line of [
		"gh api repos/o/r/pulls",
		"gh api repos/o/r/pulls/3/comments -f body=x",
		"gh pr view 3",
	])
		expect(isGateCommand(line, recommended)).toBe(false);
});

test("gh pr new needs a body like gh pr create", () => {
	expect(
		prBodyFinding("gh pr new -t x --fill", recommended, none)?.reason,
	).toContain("--fill writes the body from commits");
});

test("prHeadBranch reads --head, -H and --head=, without the owner", () => {
	expect(prHeadBranch("gh pr create --head feat/b -t x")).toBe("feat/b");
	expect(prHeadBranch("gh pr create -H me:feat/c")).toBe("feat/c");
	expect(prHeadBranch("gh pr new --head=feat/d")).toBe("feat/d");
	expect(prHeadBranch("gh pr create -t x")).toBeNull();
	expect(prHeadBranch("gh pr ready 3")).toBeNull();
});

test("gh run by its full path or as gh.exe is guarded the same", () => {
	for (const line of [
		"/usr/bin/gh pr merge 3",
		"./bin/gh pr review --approve",
		"gh.exe pr merge 3",
	])
		expect(agentApprovalFinding(line, recommended)?.id).toBe("agent-approval");
	for (const line of [
		"/opt/homebrew/bin/gh pr create -t x",
		"C:/tools/gh.exe pr ready",
	])
		expect(isGateCommand(line, recommended)).toBe(true);
	expect(
		prBodyFinding("/opt/homebrew/bin/gh pr create -t x", recommended, none)?.id,
	).toBe("pr-body");
	expect(
		isGateCommand(
			"/usr/local/bin/npm publish",
			config({
				extends: ["recommended"],
				review: { gate: ["npm publish"] },
			}),
		),
	).toBe(true);
});

test("REST pull request creation is gated whatever the flag order or spelling", () => {
	for (const line of [
		"gh api -f title=x -f head=feat/y -f base=main repos/o/r/pulls",
		"gh api repos/o/r/pulls -ftitle=x -fhead=feat/y -fbase=main",
		"gh api -XPOST /repos/o/r/pulls",
		"gh api --method=post repos/o/r/pulls",
		"gh api --raw-field=title=x repos/o/r/pulls",
		"gh api -i -F title=x 'repos/o/r/pulls'",
		"gh api --input=body.json repos/o/r/pulls",
	])
		expect(isGateCommand(line, recommended)).toBe(true);
	for (const line of [
		"gh api -X GET repos/o/r/pulls -f state=open",
		"gh api repos/o/r/pulls/3 -f title=x -X PATCH",
		"gh api repos/o/r/pulls --jq .[].number",
	])
		expect(isGateCommand(line, recommended)).toBe(false);
});

test("a body file or body attached to its flag counts as a body", () => {
	const file = "## Testing\n## Risk\n## How to revert\n";
	const read = (path: string) => (path === "pr.md" ? file : null);
	for (const line of [
		"gh pr create -t x --body-file=pr.md",
		"gh pr create -t x -Fpr.md",
	])
		expect(prBodyFinding(line, recommended, read)).toBeNull();
	expect(
		prBodyFinding("gh pr create -t x -bdone", recommended, none)?.reason,
	).toContain("The body lacks");
	expect(
		prBodyFinding(
			"gh pr create -t x -Fother.md",
			recommended,
			() => "## Testing",
		)?.reason,
	).toContain("lacks");
});
