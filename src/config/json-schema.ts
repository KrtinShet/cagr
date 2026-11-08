import { configSchema } from "./schema";

export function jsonSchema() {
	return {
		$schema: "http://json-schema.org/draft-07/schema#",
		title: "cagr.toml",
		...(configSchema.json() as object),
	};
}
