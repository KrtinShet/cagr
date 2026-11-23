import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config, Lease } from "../config/schema";
import {
	allowLeaseBreak,
	holder,
	LeaseError,
	type LeaseRecord,
	type LeaseRefs,
	type LeaseSnapshot,
	leaseRef,
	type Recorded,
	waitPrefix,
} from "./refs";

export const expired = (lease: Lease, record: { renewed: number }) =>
	Date.now() - record.renewed >= lease.ttl_seconds * 1000;

export const renewalInterval = (lease: Lease) =>
	Math.min(300_000, (lease.ttl_seconds * 1000) / 3);

export function protectedRef(config: Config, snapshot: LeaseSnapshot) {
	return config.git.protected_branch
		? `refs/heads/${config.git.protected_branch}`
		: snapshot.defaultBranch;
}

export const branchRef = (branch: string) => `refs/heads/${branch}`;

export async function heldLease(
	git: LeaseRefs,
	snapshot: LeaseSnapshot,
	lease: Lease,
) {
	const ref = leaseRef(lease.name);
	const sha = snapshot.refs.get(ref);
	return sha ? git.read(ref, sha) : null;
}

async function reclaimable(
	git: LeaseRefs,
	config: Config,
	snapshot: LeaseSnapshot,
	lease: Lease,
	record: LeaseRecord,
) {
	if (expired(lease, record)) return true;
	const remoteTip = snapshot.refs.get(branchRef(record.branch));
	if (!remoteTip && record.published) return true;
	const base = snapshot.refs.get(protectedRef(config, snapshot) ?? "");
	if (!base || !record.head) return false;
	// An unpublished head may exist only on the holder's machine. Fetch the
	// advertised tip before testing whether it contains that head.
	const tip = remoteTip ?? base;
	await git.ensureObject(tip);
	if (!(await git.git(["cat-file", "-e", record.head])).ok) return false;
	return (
		(await git.ancestor(record.head, tip)) && (await git.ancestor(tip, base))
	);
}

async function waiting(
	git: LeaseRefs,
	snapshot: LeaseSnapshot,
	lease: Lease,
	prune = false,
) {
	const prefix = waitPrefix(lease.name);
	const tickets = [];
	for (const [ref, sha] of snapshot.refs) {
		if (!ref.startsWith(prefix)) continue;
		const ticket = await git.ticket(ref, sha);
		if (!expired(lease, ticket.record)) tickets.push(ticket);
		else if (prune && (await git.change(ref, sha, null)) === null) return null;
	}
	return tickets.sort(
		(a, b) =>
			a.record.acquired - b.record.acquired ||
			(a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0),
	);
}

export async function currentBranch(git: LeaseRefs) {
	const result = await git.git(["symbolic-ref", "--quiet", "HEAD"]);
	const ref = result.stdout.trimEnd();
	if (!result.ok || !ref.startsWith("refs/heads/"))
		throw new LeaseError("Check out the branch that will land, then retry.");
	return ref.slice("refs/heads/".length);
}

export async function take(
	git: LeaseRefs,
	config: Config,
	lease: Lease,
	branch: string,
	wait: boolean,
	print: (line: string) => void,
) {
	let delay = Math.min(250, renewalInterval(lease));
	let lastPosition = "";
	for (;;) {
		const snapshot = await git.snapshot();
		const held = await heldLease(git, snapshot, lease);
		const line = await waiting(git, snapshot, lease, true);
		if (!line) continue;
		const ticket = line.find((entry) => entry.record.branch === branch);
		if (held?.record.branch === branch && !expired(lease, held.record)) {
			for (const own of line.filter(({ record }) => record.branch === branch))
				await git.change(own.ref, own.sha, null);
			print(`${lease.name} is already held by ${branch}.`);
			if (lease.after_acquire) print(lease.after_acquire);
			return 0;
		}
		if (!ticket) {
			const record = holder(branch);
			const ref = `${waitPrefix(lease.name)}${record.acquired}-${Buffer.from(branch).toString("base64url")}`;
			await git.change(ref, "", record);
			continue;
		}
		if (
			held &&
			(await reclaimable(git, config, snapshot, lease, held.record))
		) {
			await git.change(held.ref, held.sha, null);
			continue;
		}
		const branches = [...new Set(line.map(({ record }) => record.branch))];
		const position = branches.indexOf(branch) + 1;
		if (!held && position === 1) {
			if ((await currentBranch(git)) !== branch)
				throw new LeaseError(
					`The checkout changed while you waited. Switch back to ${branch} and run cagr lease take ${lease.name} again.`,
				);
			const localHead = await git.checked(["rev-parse", "HEAD"]);
			const base = snapshot.refs.get(protectedRef(config, snapshot) ?? "");
			const head =
				base && (await git.ancestor(localHead, base)) ? null : localHead;
			const record: LeaseRecord = {
				...holder(branch),
				head,
				published: snapshot.refs.has(branchRef(branch)),
			};
			if (expired(lease, ticket.record)) continue;
			if ((await git.change(leaseRef(lease.name), "", record)) === null)
				continue;
			print(`Acquired ${lease.name} for ${branch}.`);
			if (lease.after_acquire) print(lease.after_acquire);
			for (const own of line.filter(({ record }) => record.branch === branch))
				await git.change(own.ref, own.sha, null);
			return 0;
		}
		if (Date.now() - ticket.record.renewed >= renewalInterval(lease)) {
			if (
				(await git.change(ticket.ref, ticket.sha, {
					...ticket.record,
					renewed: Date.now(),
				})) === null
			)
				continue;
		}
		const status = `${lease.name}: ${held ? `held by ${held.record.branch}, ` : ""}${branch} is #${position} in line${position > 1 ? ` behind ${branches[position - 2]}` : ""}.`;
		if (status !== lastPosition) print(status);
		lastPosition = status;
		if (!wait) return 1;
		await Bun.sleep(delay);
		delay = Math.min(delay * 2, 5000, renewalInterval(lease));
	}
}

export async function renew(
	git: LeaseRefs,
	held: Recorded<LeaseRecord>,
	published: boolean,
	head = held.record.head,
) {
	const record = {
		...held.record,
		published: held.record.published || published,
		head,
		renewed: Math.max(Date.now(), held.record.renewed + 1),
	};
	const sha = await git.change(held.ref, held.sha, record);
	return sha === null ? null : { ref: held.ref, sha, record };
}

export async function list(git: LeaseRefs, config: Config) {
	const lines = [];
	if (config.lease.length === 0) return ["No serial leases are configured."];
	const snapshot = await git.snapshot();
	for (const lease of config.lease) {
		const held = await heldLease(git, snapshot, lease);
		if (held) {
			const r = held.record;
			const age = Math.max(0, Math.floor((Date.now() - r.acquired) / 1000));
			lines.push(
				`${lease.name}: ${r.branch} held by ${r.user}@${r.host} (pid ${r.pid}), age ${age}s, last renewed ${new Date(r.renewed).toISOString()}${expired(lease, r) ? " (expired)" : ""}`,
			);
		} else lines.push(`${lease.name}: free`);
		const line = await waiting(git, snapshot, lease);
		lines.push(
			...(line ?? []).map(
				({ record }, index) =>
					`  #${index + 1} ${record.branch} (last renewed ${new Date(record.renewed).toISOString()})`,
			),
		);
	}
	return lines;
}

export async function release(
	git: LeaseRefs,
	config: Config,
	lease: Lease,
	snapshot: LeaseSnapshot,
	held: Recorded<LeaseRecord>,
	force: boolean,
) {
	let log: string | undefined;
	if (force) {
		if (
			process.env[allowLeaseBreak] !== "1" &&
			!(await reclaimable(git, config, snapshot, lease, held.record))
		)
			throw new LeaseError(
				`${lease.name} is still held by ${held.record.branch}. Wait for the holder or ask a human to set ${allowLeaseBreak}=1 and run cagr lease release --break ${lease.name}.`,
			);
		const common = await git.checked([
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		]);
		const folder = join(common, "cagr");
		const actor = holder(held.record.branch);
		log = `${new Date().toISOString()} ${actor.user}@${actor.host} (pid ${actor.pid}) broke ${lease.name} held by ${held.record.branch} at ${held.sha}`;
		// Keep the audit record under the Git common directory, including when
		// the worktree that ran the command is later removed.
		await mkdir(folder, { recursive: true });
		if ((await git.change(held.ref, held.sha, null)) === null) return null;
		await appendFile(join(folder, "leases.log"), `${log}\n`);
	} else if ((await git.change(held.ref, held.sha, null)) === null) return null;
	return log ?? `Released ${lease.name} for ${held.record.branch}.`;
}
