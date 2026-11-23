import {
	closeSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, hostname, totalmem } from "node:os";
import { join } from "node:path";
import type { Config } from "../config/schema";
import { tryLock } from "./locks";
import { gib } from "./pressure";

export type Priority = "lease" | "push" | "normal";
const rank = { lease: 0, push: 1, normal: 2 };
export type Ticket = {
	id: string;
	pid: number;
	repo: string;
	branch: string;
	command: string;
	since: number;
	order: number;
	priority: Priority;
	slots: number[];
};
export type Costs = {
	totalBytes: number;
	poolTokens: number;
	dockerBytes: number;
	peaks: Record<string, number>;
};

const machine = `${hostname()}:${process.platform}:${process.arch}`;

export function cacheDir() {
	return join(homedir(), ".cache", "cagr");
}

export function readJson<T>(file: string, missing: T): T {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return missing;
		throw error;
	}
}

function writeJson(file: string, value: unknown) {
	const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
		renameSync(tmp, file);
	} finally {
		rmSync(tmp, { force: true });
	}
}

export function poolSize(config: Config["admission"], costs?: Costs) {
	const fallback = Math.max(1, Math.min(2, Math.floor(totalmem() / (2 * gib))));
	return Math.min(
		costs?.poolTokens ?? fallback,
		Math.floor(config.pool_tokens ?? Infinity),
	);
}

export const ticketOrder = (a: Ticket, b: Ticket) =>
	rank[a.priority] - rank[b.priority] || a.order - b.order;

export const describeTicket = (ticket: Ticket) =>
	`pid ${ticket.pid}, ${ticket.repo} (${ticket.branch}), ${ticket.command}, waiting since ${new Date(ticket.since).toISOString()}`;

export class Pool {
	readonly directory: string;
	private readonly tickets: string;
	private readonly file: string;

	constructor(cache = cacheDir()) {
		this.directory = join(cache, "slots");
		this.tickets = join(this.directory, "tickets");
		this.file = join(cache, "costs.json");
		mkdirSync(this.tickets, { recursive: true, mode: 0o700 });
	}

	async transaction<T>(
		deadline: number,
		action: () => T,
	): Promise<T | undefined> {
		while (performance.now() < deadline) {
			const fd = tryLock(join(this.directory, "queue.lock"));
			if (fd !== null) {
				try {
					return action();
				} finally {
					closeSync(fd);
				}
			}
			await Bun.sleep(Math.min(50, Math.max(0, deadline - performance.now())));
		}
	}

	costs() {
		return readJson<Record<string, Costs>>(this.file, {})[machine];
	}

	record(costs: Omit<Costs, "peaks">, key: string, peak: number) {
		const machines = readJson<Record<string, Costs>>(this.file, {});
		const peaks = machines[machine]?.peaks ?? {};
		writeJson(this.file, {
			...machines,
			[machine]: { ...costs, peaks: { ...peaks, [key]: peak } },
		});
	}

	list() {
		const entries: Ticket[] = [];
		for (const name of readdirSync(this.tickets)) {
			if (!name.endsWith(".json")) continue;
			const path = join(this.tickets, name);
			const stale = tryLock(path);
			if (stale !== null) {
				closeSync(stale);
				rmSync(path, { force: true });
				continue;
			}
			const ticket = readJson<Ticket | null>(path, null);
			if (ticket) entries.push(ticket);
		}
		return entries.sort(ticketOrder);
	}

	own(ticket: Ticket) {
		const fd = tryLock(join(this.tickets, `${ticket.id}.json`));
		if (fd === null)
			throw new Error("Could not lock the new admission ticket.");
		return fd;
	}

	save(ticket: Ticket) {
		// The ticket's inode is locked, and the queue lock serializes its readers.
		writeFileSync(
			join(this.tickets, `${ticket.id}.json`),
			JSON.stringify(ticket),
			{ mode: 0o600 },
		);
	}

	remove(ticket: Ticket, fd: number) {
		try {
			rmSync(join(this.tickets, `${ticket.id}.json`), { force: true });
		} finally {
			closeSync(fd);
		}
	}

	reserve(ticket: Ticket, held: Ticket[], size: number, tokens: number) {
		const taken = new Set(held.flatMap(({ slots }) => slots));
		if (taken.size + tokens > size) return null;
		const locks: number[] = [];
		const slots: number[] = [];
		const release = () => {
			for (const fd of locks) closeSync(fd);
		};
		let committed = false;
		try {
			for (let slot = 0; slot < size && locks.length < tokens; slot++) {
				if (taken.has(slot)) continue;
				const fd = tryLock(join(this.directory, `token-${slot}.lock`));
				if (fd === null) continue;
				locks.push(fd);
				slots.push(slot);
			}
			if (locks.length !== tokens) return null;
			this.save({ ...ticket, slots });
			committed = true;
			return { locks, release };
		} finally {
			if (!committed) release();
		}
	}
}
