import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AgentName } from "./agents.ts";
import { AosError } from "./errors.ts";
import { writePrivateFileAtomic } from "./fsutil.ts";
import { type AosPaths, gitCommonDir } from "./paths.ts";

/** A worktree aos leased from treehouse for one agent run, tracked for its whole life. */
export interface WorktreeRecord {
  /** Short id embedded in the branch name and used to address the worktree from the CLI. */
  readonly id: string;
  /** Agent that created this worktree; resume auto-routing only ever targets the same agent. */
  readonly agent: AgentName;
  /** Branch aos created for this worktree, under `aos/`. */
  readonly branch: string;
  /** Absolute host path of the leased worktree. */
  readonly worktreePath: string;
  /** Container directory name this worktree's launches mount at, stable for the worktree's life. */
  readonly sandboxName: string;
  /** Commit the branch was created from; set by earlier aos versions, no longer written or read. */
  readonly baseRev?: string;
  readonly createdAt: string;
  lastUsedAt: string;
  /** treehouse lease id, held from creation until `aos worktree rm`. */
  readonly leaseId: string;
  /** pid of the aos process that last launched an agent here, which may outlive the original lease holder. */
  activePid?: number;
}

const STALE_LOCK_MS = 10_000;

/** Stable identity for "this repository", the same from the main checkout or any of its worktrees. */
export function projectKey(root: string): string {
  return createHash("sha256").update(gitCommonDir(root)).digest("hex").slice(0, 16);
}

function registryFile(paths: AosPaths, key: string): string {
  return join(paths.worktrees, `${key}.json`);
}

export function readRegistry(paths: AosPaths, key: string): WorktreeRecord[] {
  const file = registryFile(paths, key);
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, "utf8")) as WorktreeRecord[];
  } catch {
    throw new AosError(`${file} is not valid JSON. Fix or remove it, then run again.`);
  }
}

function writeRegistry(paths: AosPaths, key: string, records: readonly WorktreeRecord[]): void {
  writePrivateFileAtomic(registryFile(paths, key), `${JSON.stringify(records, null, 2)}\n`);
}

/**
 * Runs `update` under an exclusive lock on this project's registry file, so two `aos` processes
 * launched at the same time (the whole point of worktree support) never clobber each other's
 * record of leased worktrees.
 */
export async function withRegistryLock<T>(
  paths: AosPaths,
  key: string,
  update: (records: WorktreeRecord[]) => { records: WorktreeRecord[]; value: T },
): Promise<T> {
  mkdirSync(paths.worktrees, { recursive: true });
  const lock = join(paths.worktrees, `${key}.lock`);
  await acquireLock(lock);
  try {
    const { records, value } = update(readRegistry(paths, key));
    writeRegistry(paths, key, records);
    return value;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

async function acquireLock(lock: string): Promise<void> {
  for (;;) {
    try {
      mkdirSync(lock);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmSync(lock, { recursive: true, force: true });
    } catch {
      // Another process cleared it first; keep polling.
    }
    await sleep(50);
  }
}
