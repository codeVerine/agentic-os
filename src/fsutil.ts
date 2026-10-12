import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { AosError } from "./errors.ts";

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 60_000;
const LOCK_POLL_MS = 50;

/** Writes a mode 0600 file through a sibling staging file and a rename, so a reader never sees a partial file. */
export function writePrivateFileAtomic(path: string, content: string): void {
  const staging = `${path}.aos-${process.pid}.tmp`;
  writeFileSync(staging, content, { mode: 0o600 });
  renameSync(staging, path);
}

export function assertPrivate(path: string, mode: number): void {
  const actual = statSync(path).mode & 0o777;
  if ((actual & 0o077) !== 0) {
    throw new AosError(
      `${path} is readable by other users (mode ${actual.toString(8)}). Run: chmod ${mode.toString(8)} ${path}`,
    );
  }
}

export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function lockOwner(lockPath: string): string | undefined {
  try {
    return readFileSync(lockPath, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Runs `run` while holding an exclusive lock file at `lockPath`, shared by every aos process on this Mac.
 * A lock older than 30 seconds is taken as abandoned, and the lock is only released by the holder that
 * wrote it, so a holder whose lock was broken never removes its successor's.
 */
export async function withFileLock<T>(lockPath: string, run: () => Promise<T>): Promise<T> {
  const owner = randomBytes(16).toString("hex");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      writeFileSync(lockPath, owner, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) unlinkSync(lockPath);
      } catch {
        // The holder released it between the checks; try to take it again.
      }
      if (Date.now() > deadline) throw new AosError(`Timed out waiting for another aos process to release ${lockPath}.`);
      await sleep(LOCK_POLL_MS);
    }
  }
  try {
    return await run();
  } finally {
    if (lockOwner(lockPath) === owner) rmSync(lockPath, { force: true });
  }
}
