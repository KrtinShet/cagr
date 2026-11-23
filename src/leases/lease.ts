import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config, Lease } from "../config/schema";
import { matchesGlob } from "../paths";
import { run } from "../run";
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

export const hasRenewalMargin = (lease: Lease, record: LeaseRecord) =>
	Date.now() - record.renewed < lease.ttl_seconds * 500;

export const renewalInterval = (lease: Lease) =>
	Math.min(300_000, (lease.ttl_seconds * 1000) / 3);

export function protectedRef(config: Config, snapshot: LeaseSnapshot) {
	return config.git.protected_branch
		? `refs/heads/${config.git.protected_branch}`
		: snapshot.defaultBranch;
}

export const branchRef = (branch: string) => `refs/heads/${branch}`;

export const touchesLease = (lease: Lease, paths: string[]) =>
	paths.some((path) => lease.paths.some((glob) => matchesGlob(glob, path)));

export async function changedPaths(
	git: LeaseRefs,
	base: string,
	head: string,
	fromMergeBase = false,
) {
	return (
		await git.checked([
			"diff",
			"--name-only",
			"--no-renames",
			"--relative",
			"--ignore-submodules=none",
			...(fromMergeBase ? ["--merge-base"] : []),
			"-z",
			base,
			head,
			"--",
		])
	)
		.split("\0")
		.filter(Boolean);
}

export async function protectedChanges(
	git: LeaseRefs,
	config: Config,
	snapshot: LeaseSnapshot,
	head: string,
) {
	const base = snapshot.refs.get(protectedRef(config, snapshot) ?? "");
	if (base && head === base) return [];
	if (!base) {
		if (
			snapshot.defaultBranch ||
			[...snapshot.refs.keys()].some((ref) => ref.startsWith("refs/heads/"))
		)
			throw new LeaseError(
				"Set [git] protected_branch to an existing branch on origin and retry.",
			);
	} else {
		await git.ensureObject(base);
		const common = await git.git(["merge-base", base, head]);
		if (common.ok) return changedPaths(git, common.stdout.trim(), head);
		if (common.exitCode !== 1)
			throw new LeaseError(
				`Could not find a merge base: ${common.output.trim()}`,
			);
	}
	return (await git.checked(["ls-tree", "-r", "--name-only", "-z", head]))
		.split("\0")
		.filter(Boolean);
}

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
	const target = protectedRef(config, snapshot);
	const base = target && snapshot.refs.get(target);
	if (!base || !record.head) return false;
	const tip = remoteTip ?? base;
	await git.ensureObject(tip);
	if (
		(await git.git(["cat-file", "-e", record.head])).ok &&
		(await git.ancestor(record.head, tip)) &&
		(await git.ancestor(tip, base))
	)
		return true;
	if (!Bun.which("gh")) return false;
	const origin = (
		await git.git(["config", "--get", "remote.origin.url"])
	).stdout.trim();
	const repo = origin
		.replace(/\.git$/, "")
		.match(
			/^(?:https?:\/\/|ssh:\/\/)?(?:[^@/:]+@)?([\w.-]+)[/:]([\w.-]+\/[\w.-]+)$/,
		);
	if (!repo) return false;
	const result = await run(
		[
			"gh",
			"pr",
			"list",
			"--repo",
			`${repo[1]}/${repo[2]}`,
			"--head",
			record.branch,
			"--base",
			target.slice("refs/heads/".length),
			"--state",
			"merged",
			"--json",
			"headRefOid,isCrossRepository,mergedAt",
		],
		git.cwd,
		{ timeoutMs: 5000, env: { GH_PROMPT_DISABLED: "1" } },
	);
	if (!result.ok) return false;
	const prs: {
		headRefOid: string;
		isCrossRepository: boolean;
		mergedAt: string;
	}[] = JSON.parse(result.stdout);
	return prs.some(
		(pr) =>
			pr.headRefOid === (remoteTip ?? record.head) &&
			!pr.isCrossRepository &&
			Date.parse(pr.mergedAt) >= Math.floor(record.acquired / 1000) * 1000,
	);
}

export async function pruneMalformed(
	git: LeaseRefs,
	ref: string,
	sha: string,
	print: (line: string) => void,
) {
	if ((await git.change(ref, sha, null)) === null) return false;
	print(`Pruned malformed serial record at ${ref}.`);
	return true;
}

export async function pruneBadTickets(
	git: LeaseRefs,
	snapshot: LeaseSnapshot,
	lease: Lease,
	print: (line: string) => void,
) {
	for (const [ref, sha] of snapshot.refs)
		if (ref.startsWith(waitPrefix(lease.name)) && !(await git.ticket(ref, sha)))
			await pruneMalformed(git, ref, sha, print);
}

async function waiting(
	git: LeaseRefs,
	snapshot: LeaseSnapshot,
	lease: Lease,
	prune?: (line: string) => void,
	report?: (line: string) => void,
) {
	const prefix = waitPrefix(lease.name);
	const tickets = [];
	for (const [ref, sha] of snapshot.refs) {
		if (!ref.startsWith(prefix)) continue;
		const ticket = await git.ticket(ref, sha);
		if (!ticket) {
			if (prune && !(await pruneMalformed(git, ref, sha, prune))) return null;
			report?.(
				`Ignored malformed ticket at ${ref}. Run cagr lease release --break ${lease.name} --prune-tickets to remove it.`,
			);
		} else if (!expired(lease, ticket.record)) tickets.push(ticket);
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
		const ref = leaseRef(lease.name);
		const sha = snapshot.refs.get(ref);
		if (!held && sha) {
			await pruneMalformed(git, ref, sha, print);
			continue;
		}
		const line = await waiting(git, snapshot, lease, print);
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
			const latest = await git.snapshot();
			if (latest.refs.has(ref)) continue;
			const refreshed = await waiting(git, latest, lease);
			if (
				refreshed?.[0]?.ref !== ticket.ref ||
				expired(lease, refreshed[0].record)
			)
				continue;
			const record: LeaseRecord = {
				...holder(branch),
				head,
				published: latest.refs.has(branchRef(branch)),
			};
			if ((await git.change(ref, "", record)) === null) continue;
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
	lease: Lease,
	held: Recorded<LeaseRecord>,
	published: boolean,
	head = held.record.head,
) {
	for (let attempt = 0; attempt < 2; attempt++) {
		if (expired(lease, held.record)) return null;
		const record = {
			...held.record,
			published: held.record.published || published,
			head,
			renewed: Math.max(Date.now(), held.record.renewed + 1),
		};
		if ((await git.change(held.ref, held.sha, record)) === null) return null;
		const current = await heldLease(git, await git.snapshot(), lease);
		if (!current || current.record.id !== record.id) return null;
		if (hasRenewalMargin(lease, current.record)) return current;
		held = current;
	}
	return null;
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
			const remaining = Math.max(
				0,
				Math.ceil((r.renewed + lease.ttl_seconds * 1000 - Date.now()) / 1000),
			);
			lines.push(
				`${lease.name}: ${r.branch} held by ${r.user}@${r.host} (pid ${r.pid}), age ${age}s, last renewed ${new Date(r.renewed).toISOString()}, ${remaining}s remaining${remaining === 0 ? " (expired)" : ""}`,
			);
		} else if (snapshot.refs.has(leaseRef(lease.name)))
			lines.push(
				`${lease.name}: malformed lease. Run cagr lease release --break ${lease.name} to remove it.`,
			);
		else lines.push(`${lease.name}: free`);
		const line = await waiting(git, snapshot, lease, undefined, (line) =>
			lines.push(line),
		);
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
