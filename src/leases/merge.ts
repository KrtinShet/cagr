import { parseLeasePolicy } from "../config/load";
import type { Config } from "../config/schema";
import { mergeBranch } from "../guards/github";
import { run } from "../run";
import { effectiveLeases, policyFile, takeAdvice } from "./check";
import { changedPaths, expired, touchesLease } from "./lease";
import { LeaseError, LeaseRefs, parseLeaseRecord } from "./refs";

const refresh =
	"git fetch --prune origin '+refs/heads/*:refs/remotes/origin/*' '+refs/cagr/lease/*:refs/cagr/cache/lease/*'";
const unchecked = `Could not verify landing leases from cached origin refs. Run \`${refresh}\`, then run \`gh pr merge <head-branch>\` on its own from this repo.`;

async function cachedLeases(git: LeaseRefs, base: string, names: string[]) {
	const source = `${base}:${policyFile}`;
	const refs = [
		source,
		...names.map((name) => `refs/cagr/cache/lease/${name}`),
	];
	const commands = [
		`info ${base}^{tree}`,
		...refs.map((ref) => `contents ${ref}`),
	];
	const output = await git.git(["cat-file", "--batch-command"], {
		stdin: `${commands.join("\n")}\n`,
	});
	if (!output.ok) throw new LeaseError(unchecked);
	const bytes = Buffer.from(output.stdout);
	let offset = 0;
	const line = () => {
		const end = bytes.indexOf(10, offset);
		if (end < 0) throw new LeaseError(unchecked);
		const text = bytes.toString("utf8", offset, end);
		offset = end + 1;
		return text;
	};
	if (!/^[a-f0-9]+ tree \d+$/.test(line())) throw new LeaseError(unchecked);
	const records = refs.map((ref) => {
		const header = line();
		if (header === `${ref} missing`) return null;
		const size = Number(header.match(/^[a-f0-9]+ blob (\d+)$/)?.[1]);
		const end = offset + size;
		if (!Number.isSafeInteger(size) || bytes[end] !== 10)
			throw new LeaseError(unchecked);
		const text = bytes.toString("utf8", offset, end);
		offset = end + 1;
		return text;
	});
	const [policy, ...leases] = records;
	return {
		policy: policy ? parseLeasePolicy(policy, source) : [],
		records: new Map(names.map((name, index) => [name, leases[index]])),
	};
}

export async function mergeLeaseFinding(
	command: string,
	cwd: string,
	config: Config,
) {
	const deadline = performance.now() + 45;
	const git = new LeaseRefs(cwd, (argv, dir, options) => {
		const timeoutMs = Math.floor(deadline - performance.now());
		if (timeoutMs <= 0) throw new LeaseError(unchecked);
		return run(argv, dir, {
			...options,
			timeoutMs,
			processGroup: false,
			env: { ...options?.env, GIT_NO_LAZY_FETCH: "1" },
		});
	});
	try {
		const base = `refs/remotes/origin/${config.git.protected_branch ?? "HEAD"}`;
		const target = mergeBranch(command);
		const names = config.lease.map(({ name }) => name);
		const [cached, diff, upstream] = await Promise.all([
			cachedLeases(git, base, names),
			target
				? changedPaths(
						git,
						base,
						target.branch
							? `refs/remotes/origin/${target.branch}`
							: "@{upstream}",
						true,
					).catch(() => null)
				: null,
			target && !target.branch
				? git.git(["rev-parse", "--symbolic-full-name", "@{upstream}"])
				: null,
		]);
		const definitions = effectiveLeases(cached.policy, config.lease);
		if (!definitions.length) return null;
		if (!target || process.env.GH_REPO) return unchecked;
		const tracking = upstream?.ok ? upstream.stdout.trim() : "";
		const origin = "refs/remotes/origin/";
		const branch =
			target.branch ??
			(tracking.startsWith(origin) ? tracking.slice(origin.length) : "");
		if (!branch || !diff) return unchecked;
		for (const lease of definitions) {
			if (!touchesLease(lease, diff)) continue;
			if (target.auto)
				return "A landing lease must still be live when the PR merges. Wait for CI and run gh pr merge without --auto.";
			const record = cached.records.get(lease.name);
			const held = record ? parseLeaseRecord(record) : null;
			if (!held || held.branch !== branch || expired(lease, held))
				return `Changes to ${lease.name} need a live lease on ${branch}. ${takeAdvice(lease.name)} Refresh the cached origin refs before merging.`;
		}
		return performance.now() < deadline ? null : unchecked;
	} catch {
		return unchecked;
	}
}
