import { parseLeasePolicy } from "../config/load";
import type { Lease } from "../config/schema";
import { branchRef, expired, heldLease, renew, touchesLease } from "./lease";
import type { LeaseRefs } from "./refs";

export const policyFile = ".cagr/serial.toml";

export async function leasePolicy(git: LeaseRefs, ref: string) {
	const entry = await git.checked(["ls-tree", ref, "--", policyFile]);
	if (!entry) return [];
	const source = `${ref}:${policyFile}`;
	return parseLeasePolicy(
		await git.checked(["cat-file", "blob", source]),
		source,
	);
}

export const takeAdvice = (name: string) =>
	`Run \`cagr lease take ${name}\`, merge the protected branch, regenerate, push, and wait for CI.`;

export function policyProblems(basePolicy: Lease[], headPolicy: Lease[]) {
	const problems: string[] = [];
	for (const lease of basePolicy) {
		const next = headPolicy.find(({ name }) => name === lease.name);
		if (
			!next ||
			next.ttl_seconds > lease.ttl_seconds ||
			lease.paths.some((path) => !next.paths.includes(path))
		)
			problems.push(
				`The PR removes or weakens lease ${lease.name}. Restore its base policy or ask a human to authorize the gate change.`,
			);
	}
	return problems;
}

export function effectiveLeases(basePolicy: Lease[], headPolicy: Lease[]) {
	const definitions = new Map(headPolicy.map((lease) => [lease.name, lease]));
	for (const lease of basePolicy) {
		const next = definitions.get(lease.name);
		definitions.set(
			lease.name,
			next
				? {
						...lease,
						paths: [...lease.paths, ...next.paths],
						ttl_seconds: Math.min(lease.ttl_seconds, next.ttl_seconds),
					}
				: lease,
		);
	}
	return [...definitions.values()];
}

export async function checkLeases(
	git: LeaseRefs,
	definitions: Lease[],
	paths: string[],
	branch: string | null | undefined,
	options: { sameRepo?: boolean; renew?: boolean } = {},
): Promise<string[] | null> {
	const needed = definitions.filter((lease) => touchesLease(lease, paths));
	if (!needed.length) return null;
	if (!branch || options.sameRepo === false)
		return [
			"Leased paths require a PR branch in origin. Publish the branch in the same repository and rerun cagr ci with the PR event.",
		];
	const problems: string[] = [];
	const snapshot = await git.snapshot();
	for (const lease of needed) {
		let held = await heldLease(git, snapshot, lease);
		if (held?.record.branch === branch && !expired(lease, held.record)) {
			if (options.renew)
				held = await renew(
					git,
					lease,
					held,
					snapshot.refs.has(branchRef(branch)),
				);
			if (held && !expired(lease, held.record)) continue;
		}
		problems.push(
			`Changes to ${lease.name} need a live lease on the PR branch. ${takeAdvice(lease.name)}`,
		);
	}
	return problems;
}
