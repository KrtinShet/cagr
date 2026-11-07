import { describe, expect, test } from "bun:test";
import { programWords } from "../shell";
import { config } from "../test/config";
import { packageManagerFinding } from "./package-manager";

const both = config({
	stack: [
		{ language: "typescript", package_manager: "pnpm" },
		{ language: "python", package_manager: "uv", paths: ["services/ml/**"] },
	],
});
const finding = (line: string, cfg = both) =>
	packageManagerFinding(programWords(line.split(" ")), cfg);

describe("JavaScript", () => {
	test.each([
		"npm i",
		"npx tsc",
		"yarn add x",
		"bun add x",
		"bunx biome check",
	])("blocks %s when pnpm is chosen", (line) => {
		expect(finding(line)?.reason).toBe(
			"This repo uses pnpm for JavaScript. Use pnpm or pnpm dlx instead of bun, bunx, npm, npx, or yarn.",
		);
	});

	test.each(["pnpm install", "pnpx tsc", "pnpm dlx tsc"])(
		"allows %s",
		(line) => {
			expect(finding(line)).toBeNull();
		},
	);
});

describe("Python", () => {
	test.each([
		"pip install requests",
		"pip3 install x",
		"poetry add x",
		"pipenv install",
		"python -m pip install x",
		"python3.12 -m pip list",
		".venv/bin/pip install x",
	])("blocks %s when uv is chosen", (line) => {
		expect(finding(line)?.reason).toBe(
			"This repo uses uv for Python. Use uv (`uv add`, `uv run`, `uv pip`) instead of pip, pip3, poetry, or pipenv.",
		);
	});

	test.each([
		"uv add requests",
		"uv pip install x",
		"uvx ruff check",
		"python -m pytest",
		"python main.py",
	])("allows %s", (line) => {
		expect(finding(line)).toBeNull();
	});
});

test("an ecosystem with no chosen manager is not guarded", () => {
	const jsOnly = config({
		stack: [{ language: "typescript", package_manager: "bun" }],
	});
	expect(finding("pip install x", jsOnly)).toBeNull();
	expect(finding("poetry add x", jsOnly)).toBeNull();
	expect(
		finding("npm i", config({ stack: [{ language: "typescript" }] })),
	).toBeNull();
});

test("two stacks may allow two managers", () => {
	const two = config({
		stack: [
			{ language: "typescript", package_manager: "bun" },
			{ language: "typescript", package_manager: "npm", paths: ["legacy/**"] },
		],
	});
	expect(finding("npm i", two)).toBeNull();
	expect(finding("bun i", two)).toBeNull();
	expect(finding("yarn", two)?.reason).toContain(
		"uses bun and npm for JavaScript",
	);
});
