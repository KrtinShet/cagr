import { Database, SQLiteError } from "bun:sqlite";

export function tryLock(path: string): Database | null {
	// SQLite's OS lock is released when the holder exits, even after SIGKILL.
	const lock = new Database(path);
	try {
		lock.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
		return lock;
	} catch (error) {
		lock.close();
		if (error instanceof SQLiteError && error.code === "SQLITE_BUSY")
			return null;
		throw error;
	}
}
