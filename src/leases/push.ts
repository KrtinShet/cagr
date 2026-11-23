import type { Config, Lease } from "../config/schema";
import type { PushedRef } from "../git-hooks";
import { matchesGlob } from "../paths";
import {
	branchRef,
	expired,
	heldLease,
	protectedRef,
	renew,
	renewalInterval,
} from "./lease";
import { LeaseError, type LeaseRecord, LeaseRefs, type Recorded } from "./refs";

type Held = {
	lease: Lease;
	entry: Recorded<LeaseRecord>;
	published: boolean;
	head: string | null;
};

export class PushLeases {
	readonly #held: Held[] = [];
	readonly #git: LeaseRefs;
	readonly #required = new Set<string>();

	constructor(
		readonly config: Config,
		readonly cwd: string,
		readonly messages: string[],
		readonly warnings: string[],
	) {
		this.#git = new LeaseRefs(cwd);
	}

	get priorityEnv() {
		// The admission runner can use the same value when it wraps verification.
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
			if (!entry) continue;
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
			});
		}
		const baseRef = protectedRef(this.config, snapshot);
		for (const ref of branches.values()) {
			if (/^0+$/.test(ref.localSha)) continue;
			const base = /^0+$/.test(ref.remoteSha)
				? snapshot.refs.get(baseRef ?? "")
				: ref.remoteSha;
			if (base)
				await this.#git.ensureObject(
					base,
					/^0+$/.test(ref.remoteSha) ? undefined : remoteUrl,
				);
			else if (snapshot.refs.has("HEAD") || snapshot.defaultBranch)
				throw new LeaseError(
					"The protected branch is missing on origin. Set [git] protected_branch to an existing branch.",
				);
			// Walk the commits, including changes reverted later in the range.
			// Combined merge diffs omit paths inherited unchanged from either parent.
			const paths = (
				await this.#git.checked([
					"log",
					"--format=",
					"--name-only",
					"-z",
					"--no-renames",
					"--diff-merges=combined",
					ref.localSha,
					...(base ? [`^${base}`] : []),
					"--",
				])
			).split("\0");
			for (const lease of this.config.lease) {
				if (
					!paths.some(
						(path) =>
							path && lease.paths.some((glob) => matchesGlob(glob, path)),
					)
				)
					continue;
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
					this.#required.add(lease.name);
					held.head = ref.localSha;
				}
			}
		}
	}

	async #renew() {
		for (const held of this.#held) {
			if (expired(held.lease, held.entry.record)) {
				if (this.#required.has(held.lease.name)) this.#lost(held.lease);
				continue;
			}
			try {
				const next = await renew(
					this.#git,
					held.entry,
					held.published,
					held.head,
				);
				if (next) held.entry = next;
				else if (this.#required.has(held.lease.name)) this.#lost(held.lease);
			} catch (error) {
				this.warnings.push(
					`Could not renew ${held.lease.name}: ${(error as Error).message}`,
				);
			}
		}
	}

	#lost(lease: Lease) {
		this.messages.push(
			`${lease.name} changed or expired during verification. Run \`cagr lease take ${lease.name}\` and retry the push.`,
		);
	}

	async verify(check: () => Promise<void>, heartbeat: boolean) {
		if (!this.#held.length) return check();
		await this.#renew();
		if (this.messages.length || !heartbeat) return;
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

	async release() {
		for (const { lease, entry } of this.#held) {
			try {
				if ((await this.#git.change(entry.ref, entry.sha, null)) !== null)
					this.warnings.push(
						`Released ${lease.name}. Run \`cagr lease take ${lease.name}\` before retrying the push.`,
					);
			} catch (error) {
				this.warnings.push(
					`Could not release ${lease.name}: ${(error as Error).message}. Run \`cagr lease release ${lease.name}\` to retry.`,
				);
			}
		}
	}
}
