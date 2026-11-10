export type Finding = {
	code: string;
	message: string;
	severity: string;
	line: number;
	endLine: number;
	column: number;
};

/** A bounded line diff. Repeated anchors stay new because their identity is ambiguous. */
export function newFindings(
	before: string,
	after: string,
	baseline: Finding[],
	current: Finding[],
): Finding[] {
	const a = before.split("\n"),
		b = after.split("\n");
	if (a.length * b.length > 2_000_000) return current;
	const width = b.length + 1;
	const diff = new Uint32Array((a.length + 1) * width);
	for (let i = a.length - 1; i >= 0; i--)
		for (let j = b.length - 1; j >= 0; j--)
			diff[i * width + j] =
				a[i] === b[j]
					? 1 + (diff[(i + 1) * width + j + 1] ?? 0)
					: Math.max(
							diff[(i + 1) * width + j] ?? 0,
							diff[i * width + j + 1] ?? 0,
						);
	const counts = (lines: string[]) => {
		const result = new Map<string, number>();
		for (const line of lines) result.set(line, (result.get(line) ?? 0) + 1);
		return result;
	};
	const ac = counts(a),
		bc = counts(b),
		mapping = new Map<number, number>();
	let i = 0,
		j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			if (ac.get(a[i] as string) === 1 && bc.get(b[j] as string) === 1)
				mapping.set(i + 1, j + 1);
			i++;
			j++;
		} else if (
			(diff[(i + 1) * width + j] ?? 0) >= (diff[i * width + j + 1] ?? 0)
		)
			i++;
		else j++;
	}
	const remaining = [...baseline];
	return current.filter((finding) => {
		const index = remaining.findIndex(
			(old) =>
				old.code === finding.code &&
				old.message === finding.message &&
				old.severity === finding.severity &&
				old.column === finding.column &&
				old.endLine - old.line === finding.endLine - finding.line &&
				Array.from(
					{ length: old.endLine - old.line + 1 },
					(_, offset) =>
						mapping.get(old.line + offset) === finding.line + offset,
				).every(Boolean),
		);
		if (index < 0) return true;
		remaining.splice(index, 1);
		return false;
	});
}
