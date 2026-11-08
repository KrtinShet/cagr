import { expect, test } from "bun:test";
import { classify, fileRisk, riskReport } from "./risk";
import { config } from "./test/config";

const settings = config({
	extends: ["recommended"],
	risk: {
		paths: [
			{
				glob: "src/auth/**",
				tier: "high",
				owners: ["@org/security"],
				reason: "Sign-in.",
			},
		],
	},
});

test("a file takes the tier of the glob it matches, or the default", () => {
	expect(fileRisk("src/auth/session.ts", settings).tier).toBe("high");
	expect(fileRisk("src/app.ts", settings).tier).toBe("medium");
	expect(fileRisk("README.md", settings).tier).toBe("low");
	expect(fileRisk("docs/guide/setup.md", settings).tier).toBe("low");
	expect(fileRisk(".github/workflows/ci.yml", settings).tier).toBe("high");
});

test("the change takes its highest file, with that file's reasons and owners", () => {
	const result = classify(["README.md", "src/auth/session.ts"], settings);
	expect(result.tier).toBe("high");
	expect(result.approvals).toBe(2);
	expect(result.owners).toEqual(["@org/security"]);
	expect(result.reasons).toEqual(["Sign-in."]);
	expect(riskReport(result)).toContain("Needs 2 human approvals");
	expect(riskReport(result)).toContain("Why: Sign-in.\n");
});

test("docs alone are low and need no approval", () => {
	const result = classify(["README.md", "docs/a.md"], settings);
	expect(result.tier).toBe("low");
	expect(result.approvals).toBe(0);
	expect(classify([], settings).tier).toBe("low");
});
