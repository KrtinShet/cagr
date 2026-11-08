/**
 * A small schema language. One description gives both the validator (with
 * messages that name the key and the fix) and the JSON schema editors read.
 */
export type JsonSchema = Record<string, unknown>;

export type Node = {
	check(value: unknown, path: string, errors: string[]): void;
	json(): JsonSchema;
};

type Doc = { description?: string };

const typeName = (value: unknown) =>
	Array.isArray(value)
		? "a list"
		: value === null
			? "null"
			: `a ${typeof value}`;

export function str(
	opts: Doc & { enum?: readonly string[]; minLength?: number } = {},
): Node {
	return {
		check(value, path, errors) {
			if (typeof value !== "string") {
				errors.push(`${path} must be a string, not ${typeName(value)}.`);
				return;
			}
			if (opts.enum && !opts.enum.includes(value))
				errors.push(
					`${path} is "${value}". Use one of: ${opts.enum.map((v) => `"${v}"`).join(", ")}.`,
				);
			if (opts.minLength && value.length < opts.minLength)
				errors.push(`${path} must not be empty.`);
		},
		json: () => ({
			type: "string",
			...(opts.enum ? { enum: opts.enum } : {}),
			...(opts.minLength ? { minLength: opts.minLength } : {}),
			...(opts.description ? { description: opts.description } : {}),
		}),
	};
}

export function bool(opts: Doc = {}): Node {
	return {
		check(value, path, errors) {
			if (typeof value !== "boolean")
				errors.push(`${path} must be true or false, not ${typeName(value)}.`);
		},
		json: () => ({ type: "boolean", ...opts }),
	};
}

export function num(opts: Doc & { min?: number } = {}): Node {
	return {
		check(value, path, errors) {
			if (typeof value !== "number" || !Number.isInteger(value)) {
				errors.push(`${path} must be a whole number, not ${typeName(value)}.`);
				return;
			}
			if (opts.min !== undefined && value < opts.min)
				errors.push(`${path} must be at least ${opts.min}.`);
		},
		json: () => ({
			type: "integer",
			...(opts.min !== undefined ? { minimum: opts.min } : {}),
			...(opts.description ? { description: opts.description } : {}),
		}),
	};
}

export function arr(item: Node, opts: Doc = {}): Node {
	return {
		check(value, path, errors) {
			if (!Array.isArray(value)) {
				errors.push(`${path} must be a list, not ${typeName(value)}.`);
				return;
			}
			value.forEach((entry, index) => {
				item.check(entry, `${path}[${index}]`, errors);
			});
		},
		json: () => ({ type: "array", items: item.json(), ...opts }),
	};
}

export function obj(
	props: Record<string, Node>,
	opts: Doc & { required?: string[] } = {},
): Node {
	return {
		check(value, path, errors) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				errors.push(
					`${path || "config"} must be a table, not ${typeName(value)}.`,
				);
				return;
			}
			const record = value as Record<string, unknown>;
			for (const key of opts.required ?? [])
				if (!(key in record)) errors.push(`${join(path, key)} is required.`);
			for (const [key, entry] of Object.entries(record)) {
				const node = props[key];
				if (node) node.check(entry, join(path, key), errors);
				else errors.push(unknownKey(join(path, key), key, Object.keys(props)));
			}
		},
		json: () => ({
			type: "object",
			additionalProperties: false,
			properties: Object.fromEntries(
				Object.entries(props).map(([key, node]) => [key, node.json()]),
			),
			...(opts.required ? { required: opts.required } : {}),
			...(opts.description ? { description: opts.description } : {}),
		}),
	};
}

/** The first alternative whose check passes wins; otherwise its own errors are reported. */
export function oneOf(nodes: Node[], opts: Doc & { hint: string }): Node {
	return {
		check(value, path, errors) {
			for (const node of nodes) {
				const own: string[] = [];
				node.check(value, path, own);
				if (own.length === 0) return;
			}
			errors.push(`${path} ${opts.hint}`);
		},
		json: () => ({
			anyOf: nodes.map((node) => node.json()),
			...(opts.description ? { description: opts.description } : {}),
		}),
	};
}

function join(path: string, key: string) {
	return path ? `${path}.${key}` : key;
}

function unknownKey(path: string, key: string, known: string[]) {
	const close = known
		.map((candidate) => ({ candidate, distance: distance(key, candidate) }))
		.filter(({ distance }) => distance <= 3)
		.sort((a, b) => a.distance - b.distance)[0];
	return close
		? `${path} is not a known key. Did you mean ${close.candidate}?`
		: `${path} is not a known key. Known keys here: ${known.join(", ")}.`;
}

function distance(a: string, b: string) {
	const row = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		let previous = row[0] as number;
		row[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const current = row[j] as number;
			row[j] = Math.min(
				(row[j] as number) + 1,
				(row[j - 1] as number) + 1,
				previous + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
			previous = current;
		}
	}
	return row[b.length] as number;
}
