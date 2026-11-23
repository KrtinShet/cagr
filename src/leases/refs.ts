import { hostname, userInfo } from "node:os";
import { gitHookEnv } from "../git";
import { type RunOptions, run } from "../run";

export const serialRef = "refs/cagr/";
export const leaseRef = (name: string) => `${serialRef}lease/${name}`;
export const waitPrefix = (name: string) => `${serialRef}wait/${name}/`;
export const allowLeaseBreak = "CAGR_ALLOW_LEASE_BREAK";
export const leasePush = "CAGR_INTERNAL_LEASE_PUSH";
export const useLeaseCommand =
	"Use cagr lease to take, renew or release the lease and keep your place in line.";

export class LeaseError extends Error {}

type Holder = {
	branch: string;
	host: string;
	pid: number;
	user: string;
	acquired: number;
	renewed: number;
	id: string;
};
export type LeaseRecord = Holder & { head: string | null; published: boolean };
export type Recorded<T> = { ref: string; sha: string; record: T };

export function holder(branch: string): Holder {
	const now = Date.now();
	return {
		branch,
		host: hostname(),
		pid: process.pid,
		user: userInfo().username,
		acquired: now,
		renewed: now,
		id: crypto.randomUUID(),
	};
}

const shaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export class LeaseRefs {
	readonly #records = new Map<string, Holder>();
	#url?: string;

	constructor(
		readonly cwd: string,
		readonly execute = run,
	) {}

	async git(args: string[], options: RunOptions = {}) {
		return this.execute(["git", ...args], this.cwd, {
			timeoutMs: 15_000,
			...options,
			env: { ...gitHookEnv, ...options.env },
		});
	}

	async checked(args: string[], options?: RunOptions) {
		const result = await this.git(args, options);
		if (!result.ok)
			throw new LeaseError(`git ${args[0]} failed: ${result.output.trim()}`);
		return result.stdout.trimEnd();
	}

	async #origin() {
		if (this.#url === undefined) {
			const urls = (
				await this.checked(["remote", "get-url", "--push", "--all", "origin"])
			).split("\n");
			if (urls.length !== 1 || !urls[0])
				throw new LeaseError(
					"Leases need a single origin push URL. Set one and retry.",
				);
			this.#url = urls[0];
		}
		return this.#url;
	}

	async snapshot() {
		const output = await this.checked([
			"ls-remote",
			"--symref",
			"--",
			await this.#origin(),
			"HEAD",
			"refs/heads/*",
			`${serialRef}lease/*`,
			`${serialRef}wait/*`,
		]);
		const refs = new Map<string, string>();
		let defaultBranch: string | undefined;
		for (const line of output.split("\n")) {
			const [value, ref] = line.split("\t");
			if (!ref || !value) continue;
			if (shaPattern.test(value)) refs.set(ref, value);
			else if (ref === "HEAD" && value.startsWith("ref: refs/heads/"))
				defaultBranch = value.slice("ref: ".length);
		}
		return { refs, defaultBranch };
	}

	async ensureObject(sha: string, url?: string) {
		if (!(await this.git(["cat-file", "-e", sha])).ok)
			await this.checked([
				"fetch",
				"--no-tags",
				"--no-write-fetch-head",
				"--",
				url ?? (await this.#origin()),
				sha,
			]);
	}

	async read(ref: string, sha: string): Promise<Recorded<LeaseRecord> | null> {
		const entry = await this.ticket(ref, sha);
		return entry && isLease(entry.record)
			? { ref, sha, record: entry.record }
			: null;
	}

	async ticket(ref: string, sha: string): Promise<Recorded<Holder> | null> {
		let record = this.#records.get(sha);
		if (!record) {
			let result = await this.git(["cat-file", "blob", sha]);
			if (!result.ok) {
				await this.ensureObject(sha);
				result = await this.git(["cat-file", "blob", sha]);
			}
			let value: unknown;
			try {
				value = JSON.parse(result.stdout);
			} catch {
				return null;
			}
			if (!isHolder(value)) return null;
			record = value;
			this.#records.set(sha, record);
		}
		return { ref, sha, record };
	}

	async change(
		ref: string,
		expected: string,
		record: Holder | null,
	): Promise<string | null> {
		const sha = record
			? await this.checked(["hash-object", "-w", "--stdin"], {
					stdin: JSON.stringify(record),
				})
			: "";
		const result = await this.git(
			[
				"push",
				"--porcelain",
				`--force-with-lease=${ref}:${expected}`,
				"origin",
				`${sha}:${ref}`,
			],
			{ env: { [leasePush]: "1" } },
		);
		if (!result.ok) {
			const actual = (await this.snapshot()).refs.get(ref) ?? "";
			if (record && actual === sha) return sha;
			if (actual !== expected) return null;
			throw new LeaseError(`Could not update ${ref}: ${result.output.trim()}`);
		}
		if (record) this.#records.set(sha, record);
		return sha;
	}

	async ancestor(older: string, newer: string) {
		if (older === newer) return true;
		await this.ensureObject(newer);
		await this.ensureObject(older);
		const result = await this.git([
			"merge-base",
			"--is-ancestor",
			older,
			newer,
		]);
		if (result.exitCode === 0) return true;
		if (result.exitCode === 1) return false;
		throw new LeaseError(
			`Could not check branch ancestry: ${result.output.trim()}`,
		);
	}
}

export type LeaseSnapshot = Awaited<ReturnType<LeaseRefs["snapshot"]>>;

function printable(value: unknown): value is string {
	return (
		typeof value === "string" && value.length > 0 && !/\p{Cc}/u.test(value)
	);
}

function isHolder(value: unknown): value is Holder {
	return (
		typeof value === "object" &&
		value !== null &&
		"branch" in value &&
		printable(value.branch) &&
		"host" in value &&
		printable(value.host) &&
		"user" in value &&
		printable(value.user) &&
		"id" in value &&
		typeof value.id === "string" &&
		"pid" in value &&
		typeof value.pid === "number" &&
		Number.isSafeInteger(value.pid) &&
		"acquired" in value &&
		typeof value.acquired === "number" &&
		Number.isSafeInteger(value.acquired) &&
		value.acquired >= 0 &&
		value.acquired <= 8.64e15 &&
		"renewed" in value &&
		typeof value.renewed === "number" &&
		Number.isSafeInteger(value.renewed) &&
		value.renewed >= 0 &&
		value.renewed <= 8.64e15
	);
}

function isLease(value: Holder): value is LeaseRecord {
	return (
		"head" in value &&
		(value.head === null ||
			(typeof value.head === "string" && shaPattern.test(value.head))) &&
		"published" in value &&
		typeof value.published === "boolean"
	);
}
