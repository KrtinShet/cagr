import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { jsonSchema } from "./json-schema";

test("schema/cagr.schema.json matches the config schema (run `bun run schema`)", () => {
	const file = join(import.meta.dir, "../../schema/cagr.schema.json");
	expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(jsonSchema());
});

test("the schema rejects unknown keys and lists stack fields", () => {
	const schema = jsonSchema() as unknown as {
		additionalProperties: boolean;
		properties: Record<string, { items?: { required?: string[] } }>;
	};
	expect(schema.additionalProperties).toBe(false);
	expect(schema.properties.stack?.items?.required).toEqual(["language"]);
});
