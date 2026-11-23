import type { Config, Lease } from "../config/schema";
import type { PushedRef } from "../git-hooks";
import {
	branchRef,
	changedPaths,
	expired,
	hasRenewalMargin,
	heldLease,
	protectedChanges,
	renew,
	renewalInterval,
	touchesLease,
} from "./lease";
import {
	type LeaseRecord,
	LeaseRefs,
	type LeaseSnapshot,
	type Recorded,
} from "./refs";

const zero = /^0+$/;

type Held = {
	lease: Lease;
	entry: Recorded<LeaseRecord>;
	published: boolean;
	head: string | null;
	required: boolean;
};

export class PushLeases {
	readonly #held: Held[] = [];
	readonly #git: LeaseRefs;

	constructor(
		readonly config: Config,
		readonly cwd: string,
		readonly messages: string[],
		readonly warnings: string[],
	) {
		this.#git = new LeaseRefs(cwd);
	}

	get priorityEnv() {
		return this.#held.length ? { CAGR_PRIORITY: "lease" } : {};
	}

	async inspect(refs: PushedRef[], remoteUrl?: string) {
		const branches = new Map(
			refs
				.filter(({ remoteRef }) => remoteRef.startsWith("refs/heads/"))
				.map((ref) => [ref.remoteRef, ref]),
		);
		if (!this.config.lease.length || !branches.size) return;
		const snapshot = await this.#git.snapshot();
		const usesHead = [...branches.values()].some(
			({ localRef }) => localRef === "HEAD" || localRef === "(delete)",
		);
		const head = usesHead
			? (
					await this.#git.git(["symbolic-ref", "--quiet", "HEAD"])
				).stdout.trimEnd()
			: "";
		for (const lease of this.config.lease) {
			const entry = await heldLease(this.#git, snapshot, lease);
			if (!entry || expired(lease, entry.record)) continue;
			const holderRef = branchRef(entry.record.branch);
			const pushedRef = branches.get(holderRef);
			if (!pushedRef) continue;
			const source =
				pushedRef.localRef === "HEAD" || pushedRef.localRef === "(delete)"
					? head
					: pushedRef.localRef;
			if (source !== holderRef) continue;
			this.#held.push({
				lease,
				entry,
				published: snapshot.refs.has(holderRef),
				head: entry.record.head,
				required: false,
			});
		}
		for (const ref of branches.values()) {
			if (zero.test(ref.localSha)) continue;
			try {
				await this.#inspectRef(ref, snapshot, remoteUrl);
			} catch (error) {
				this.messages.push(
					`Could not check leases for ${ref.remoteRef}: ${(error as Error).message}. Fetch origin, run cagr lease list, and retry the push.`,
				);
			}
		}
	}

	async #inspectRef(
		ref: PushedRef,
		snapshot: LeaseSnapshot,
		remoteUrl?: string,
	) {
		const paths = await protectedChanges(
			this.#git,
			this.config,
			snapshot,
			ref.localSha,
		);
		const originTip = snapshot.refs.get(ref.remoteRef);
		const publishedPaths = originTip
			? await protectedChanges(this.#git, this.config, snapshot, originTip)
			: [];
		if (!zero.test(ref.remoteSha)) {
			await this.#git.ensureObject(ref.remoteSha, remoteUrl);
			const updated = await changedPaths(
				this.#git,
				ref.remoteSha,
				ref.localSha,
			);
			if (await this.#git.ancestor(ref.remoteSha, ref.localSha)) {
				// Also guard branch-only changes that disappear in this update.
				const pending =
					ref.remoteSha === originTip
						? publishedPaths
						: await protectedChanges(
								this.#git,
								this.config,
								snapshot,
								ref.remoteSha,
							);
				const deleted = new Set(pending);
				paths.push(...updated.filter((path) => deleted.has(path)));
			} else paths.push(...updated);
		}
		for (const lease of this.config.lease) {
			if (!touchesLease(lease, paths)) continue;
			const held = this.#held.find(
				({ entry, lease: definition }) =>
					definition === lease &&
					branchRef(entry.record.branch) === ref.remoteRef,
			);
			if (!held || expired(lease, held.entry.record))
				this.messages.push(
					`Changes to ${lease.name} need its lease. Run \`cagr lease take ${lease.name}\` on ${ref.remoteRef.slice("refs/heads/".length)} and retry the push.`,
				);
			else {
				held.required = true;
				held.head =
					originTip && touchesLease(lease, publishedPaths)
						? originTip
						: ref.localSha;
			}
		}
	}

	async #renew() {
		for (const held of this.#held) {
			try {
				const next = await renew(
					this.#git,
					held.lease,
					held.entry,
					held.published,
					held.head,
				);
				if (next) {
					held.entry = next;
					continue;
				}
			} catch (error) {
				this.warnings.push(
					`Could not renew ${held.lease.name}: ${(error as Error).message}`,
				);
			}
			if (held.required) this.#lost(held.lease);
		}
	}

	#lost(lease: Lease) {
		this.messages.push(
			`${lease.name} changed or has too little time left. Run \`cagr lease take ${lease.name}\` and retry the push.`,
		);
	}

	async verify(
		check: () => Promise<void>,
		heartbeat: boolean,
		writable: boolean,
	) {
		if (!this.#held.length || !writable) {
			await check();
		} else {
			await this.#renew();
			if (heartbeat && !this.messages.length) await this.#heartbeat(check);
		}
		for (const { lease, entry } of this.#held)
			if (!hasRenewalMargin(lease, entry.record)) this.#lost(lease);
	}

	async #heartbeat(check: () => Promise<void>) {
		const interval = Math.min(
			...this.#held.map(({ lease }) => renewalInterval(lease)),
		);
		let pending: Promise<void> | undefined;
		const timer = setInterval(() => {
			if (!pending && !this.messages.length)
				pending = this.#renew().finally(() => {
					pending = undefined;
				});
		}, interval);
		try {
			await check();
		} finally {
			clearInterval(timer);
			await pending;
		}
		if (!this.messages.length) await this.#renew();
	}

	async releaseUnpublished() {
		for (const { lease, entry } of this.#held) {
			try {
				const snapshot = await this.#git.snapshot();
				const tip = snapshot.refs.get(branchRef(entry.record.branch));
				if (
					tip &&
					touchesLease(
						lease,
						await protectedChanges(this.#git, this.config, snapshot, tip),
					)
				) {
					this.warnings.push(
						`Kept ${lease.name} because ${entry.record.branch} already has leased changes on origin. Renew the lease while the PR is open.`,
					);
					continue;
				}
				if ((await this.#git.change(entry.ref, entry.sha, null)) !== null)
					this.warnings.push(
						`Released ${lease.name}. Run \`cagr lease take ${lease.name}\` before retrying the push.`,
					);
			} catch (error) {
				this.warnings.push(
					`Could not check or release ${lease.name}: ${(error as Error).message}. Run \`cagr lease list\` before retrying the push.`,
				);
			}
		}
	}
}
