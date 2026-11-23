import type { Config } from "../config/schema";
import {
	branchRef,
	currentBranch,
	expired,
	heldLease,
	list,
	pruneBadTickets,
	pruneMalformed,
	release,
	renew,
	take,
} from "./lease";
import { LeaseError, LeaseRefs, leaseRef } from "./refs";

const usage =
	"Usage: cagr lease list | take <name> [--wait] | renew <name> | release <name> [--break [--prune-tickets]]";

export async function leaseCommand(config: Config, args: string[]) {
	const [action, ...rest] = args;
	const flags = rest.filter((arg) => arg.startsWith("-"));
	const names = rest.filter((arg) => !arg.startsWith("-"));
	const force = flags.includes("--break");
	const prune = flags.includes("--prune-tickets");
	const allowed =
		action === "take"
			? ["--wait"]
			: action === "release"
				? ["--break", "--prune-tickets"]
				: [];
	if (
		!action ||
		!["list", "take", "renew", "release"].includes(action) ||
		names.length !== (action === "list" ? 0 : 1) ||
		flags.some((flag) => !allowed.includes(flag)) ||
		new Set(flags).size !== flags.length ||
		(prune && !force)
	)
		throw new LeaseError(usage);
	const git = new LeaseRefs(config.root);
	if (action === "list") {
		for (const line of await list(git, config)) console.log(line);
		return 0;
	}
	const lease = config.lease.find((entry) => entry.name === names[0]);
	if (!lease)
		throw new LeaseError(`Unknown lease "${names[0]}". Run cagr lease list.`);
	if (action === "take")
		return take(
			git,
			config,
			lease,
			await currentBranch(git),
			flags.length > 0,
			console.log,
		);

	const snapshot = await git.snapshot();
	if (prune) {
		await pruneBadTickets(git, snapshot, lease, console.log);
		return 0;
	}
	const held = await heldLease(git, snapshot, lease);
	if (!held) {
		const ref = leaseRef(lease.name);
		const sha = snapshot.refs.get(ref);
		if (sha) {
			if (force && (await pruneMalformed(git, ref, sha, console.log))) return 0;
			throw new LeaseError(
				`${lease.name} has a malformed record. Run cagr lease list or cagr lease release --break ${lease.name} to remove it.`,
			);
		}
		throw new LeaseError(
			`${lease.name} is free. Run cagr lease take ${lease.name} to acquire it.`,
		);
	}
	if (!force && held.record.branch !== (await currentBranch(git)))
		throw new LeaseError(
			`${lease.name} is held by ${held.record.branch}. Switch to that branch or run cagr lease list.`,
		);
	if (action === "renew" && expired(lease, held.record))
		throw new LeaseError(
			`${lease.name} expired. Run cagr lease take ${lease.name} to join the line again.`,
		);
	const result =
		action === "renew"
			? await renew(
					git,
					lease,
					held,
					snapshot.refs.has(branchRef(held.record.branch)),
				)
			: await release(git, config, lease, snapshot, held, force);
	if (result === null)
		throw new LeaseError(
			`${lease.name} changed while you worked. Run cagr lease list and retry.`,
		);
	console.log(
		typeof result === "string"
			? result
			: `Renewed ${lease.name} for ${held.record.branch}.`,
	);
	return 0;
}
