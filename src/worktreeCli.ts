import { existsSync, mkdirSync } from "node:fs";
import { basename } from "node:path";
import { AosError } from "./errors.ts";
import { deleteBranch, isMergedInto, isWorktreeClean, mainCheckout, mergeLocally } from "./git.ts";
import { type AosPaths, gitCommonDir, locateProject } from "./paths.ts";
import { formatLandingReview, landingReview } from "./landing.ts";
import { projectKey, readRegistry, withRegistryLock, type WorktreeRecord } from "./registry.ts";
import {
  describeImport,
  readSessionTip,
  removeSessionGitDir,
  sessionGitDirExists,
  sessionGitPaths,
  syncSession,
} from "./sessiongit.ts";
import { leaseEnded, liveHolderPid, returnWorktree, treehouseStatus, type TreehouseStatusEntry } from "./treehouse.ts";

const USAGE = `Usage: aos worktree <list|merge|rm|prune> [args]

  aos worktree list          List this project's aos-leased worktrees
  aos worktree merge <id>    Import the session's commits, then merge its branch into the main checkout's
                              current branch, locally
  aos worktree rm <id>       Return the lease and delete the branch (refuses on unmerged or
                              uncommitted work; add --force to discard it)
  aos worktree prune         Remove every worktree already merged and clean`;

export async function worktreeCommand(args: readonly string[], cwd: string, paths: AosPaths): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
      return listWorktrees(cwd, paths);
    case "merge":
      return mergeWorktree(requireId(rest), cwd, paths);
    case "rm":
    case "remove":
      return removeWorktree(requireId(rest.filter((a) => a !== "--force")), rest.includes("--force"), cwd, paths);
    case "prune":
      return pruneWorktrees(cwd, paths);
    default:
      throw new AosError(sub === undefined ? USAGE : `Unknown "aos worktree ${sub}".\n\n${USAGE}`);
  }
}

function requireId(rest: readonly string[]): string {
  const [id] = rest;
  if (!id) throw new AosError(USAGE);
  return id;
}

function findRecord(records: readonly WorktreeRecord[], id: string): WorktreeRecord {
  const record = records.find((r) => r.id === id || r.branch === id);
  if (!record) throw new AosError(`No aos worktree "${id}" for this project. Run "aos worktree list" to see the current ones.`);
  return record;
}

function locateMainCheckout(cwd: string): { mainRoot: string; key: string } {
  const mainRoot = mainCheckout(locateProject(cwd).root);
  return { mainRoot, key: projectKey(mainRoot) };
}

/** The branch holding a session's imported commits: the session branch, or the one a diverged import went to. */
const workBranch = (record: WorktreeRecord): string => record.importBranch ?? record.branch;

/**
 * Imports the commits a session made in its private git directory into the repository, so the branch the
 * Mac sees is current. A record from before private git directories has nothing to import. A failed import
 * is reported and leaves the session's git directory in place for the next try.
 */
async function importPending(
  paths: AosPaths,
  key: string,
  mainRoot: string,
  record: WorktreeRecord,
  folderIsOurs = true,
): Promise<WorktreeRecord> {
  const session = sessionGitPaths(paths, key, record.id);
  if (!sessionGitDirExists(session)) return record;
  mkdirSync(paths.run, { recursive: true });
  try {
    const { record: updated, outcome } = await syncSession({
      paths,
      key,
      commonDir: gitCommonDir(mainRoot),
      worktreePath: folderIsOurs && existsSync(record.worktreePath) ? record.worktreePath : undefined,
      session,
      scratchDir: paths.run,
    });
    const message = describeImport(outcome, record.branch);
    if (message) console.error(`aos: ${message}`);
    return updated;
  } catch (error) {
    console.error(`aos: could not import the commits of ${record.id}: ${(error as Error).message}`);
    return record;
  }
}

/**
 * Imports a session's pending commits unless an aos process still runs an agent in it (its own live
 * import handles that). Never runs under the registry lock, which the import takes to record its tip.
 */
async function importIdle(paths: AosPaths, key: string, mainRoot: string, id: string): Promise<void> {
  const record = readRegistry(paths, key).find((r) => r.id === id);
  if (record === undefined || !existsSync(record.worktreePath) || !hasUnimportedCommits(paths, key, record)) return;
  const status = treehouseStatus(mainRoot, [record.poolRoot]);
  if (liveHolderPid(record, status) !== undefined) return;
  await importPending(paths, key, mainRoot, record, !leaseEnded(record, status));
}

/** Commits are waiting in the session's git directory that the repository's branch does not have yet. */
function hasUnimportedCommits(paths: AosPaths, key: string, record: WorktreeRecord): boolean {
  const session = sessionGitPaths(paths, key, record.id);
  if (!sessionGitDirExists(session)) return false;
  const tip = readSessionTip(session, record.branch);
  return tip !== undefined && tip !== record.importedTip;
}

/** Every treehouse pool the records were leased from: the dedicated aos pool, or the default one for older records. */
const poolsOf = (records: readonly WorktreeRecord[]): (string | undefined)[] => records.map((record) => record.poolRoot);

async function listWorktrees(cwd: string, paths: AosPaths): Promise<number> {
  const { mainRoot, key } = locateMainCheckout(cwd);
  const stored = readRegistry(paths, key);
  if (stored.length === 0) {
    console.log(`No aos worktrees for ${basename(mainRoot)}.`);
    return 0;
  }
  const live = treehouseStatus(mainRoot, poolsOf(stored));
  const records: WorktreeRecord[] = [];
  for (const record of stored) {
    const running = liveHolderPid(record, live) !== undefined;
    const pending = !running && hasUnimportedCommits(paths, key, record);
    records.push(pending ? await importPending(paths, key, mainRoot, record, !leaseEnded(record, live)) : record);
  }
  for (const record of records) {
    const gone = !existsSync(record.worktreePath);
    const ended = !gone && leaseEnded(record, live);
    const leaseState = gone ? "gone" : ended ? "ended" : (live?.find((e) => e.path === record.worktreePath)?.status ?? "unknown");
    const merged = !gone && isMergedInto(mainRoot, workBranch(record));
    const mergeFlag = (merged ? "merged" : "unmerged") + (hasUnimportedCommits(paths, key, record) ? ", unsynced" : "");
    // An ended lease's folder may belong to another session now, so its state says nothing about this record.
    const flags = gone ? "" : ended ? ` (${mergeFlag})` : ` (${isWorktreeClean(record.worktreePath) ? "clean" : "dirty"}, ${mergeFlag})`;
    console.log(`${record.id}  ${record.agent.padEnd(8)} ${leaseState.padEnd(9)} ${record.branch}${flags}`);
    console.log(`    ${record.worktreePath}`);
  }
  return 0;
}

async function mergeWorktree(id: string, cwd: string, paths: AosPaths): Promise<number> {
  const { mainRoot, key } = locateMainCheckout(cwd);
  const found = findRecord(readRegistry(paths, key), id);
  const folderIsOurs = !leaseEnded(found, treehouseStatus(mainRoot, [found.poolRoot]));
  const record = await importPending(paths, key, mainRoot, found, folderIsOurs);
  const branch = workBranch(record);
  try {
    const block = formatLandingReview(branch, landingReview(mainRoot, branch));
    if (block) console.error(block);
  } catch (error) {
    // The review is advisory, but a skipped review must be visible, not silent.
    console.error(`aos: landing review unavailable: ${(error as Error).message}`);
  }
  mergeLocally(mainRoot, branch);
  console.log(`aos: merged ${branch} into the branch checked out in ${mainRoot}.`);
  console.log(`aos: run "aos worktree rm ${record.id}" to release its worktree and delete the branch.`);
  return 0;
}

async function removeWorktree(id: string, force: boolean, cwd: string, paths: AosPaths): Promise<number> {
  const { mainRoot, key } = locateMainCheckout(cwd);
  // Import before taking the lock: the import writes the record under it. A forced removal discards the
  // session's commits anyway, so it needs no import (and no Docker).
  if (!force) await importIdle(paths, key, mainRoot, id);
  // Under the registry lock, so a resume cannot claim the worktree between the checks and the return.
  await withRegistryLock(paths, key, (records) => {
    const record = findRecord(records, id);
    removeOne(paths, key, mainRoot, record, force, treehouseStatus(mainRoot, [record.poolRoot]));
    return { records: records.filter((r) => r.id !== record.id), value: undefined };
  });
  return 0;
}

type PruneOutcome = "removed" | "kept" | "failed";

async function pruneWorktrees(cwd: string, paths: AosPaths): Promise<number> {
  const { mainRoot, key } = locateMainCheckout(cwd);
  const ids = readRegistry(paths, key).map((r) => r.id);
  const outcomes: PruneOutcome[] = [];
  for (const id of ids) {
    await importIdle(paths, key, mainRoot, id);
    // One lock per worktree, taken fresh, so each is judged on the registry as it is now and a
    // resume that claimed it since the listing keeps it.
    outcomes.push(
      await withRegistryLock(paths, key, (records) => {
        const record = records.find((r) => r.id === id);
        const outcome = record ? pruneOne(paths, key, mainRoot, record) : "kept";
        return { records: outcome === "removed" ? records.filter((r) => r.id !== id) : records, value: outcome };
      }),
    );
  }
  const removed = outcomes.filter((o) => o === "removed").length;
  console.log(`aos: removed ${removed} worktree${removed === 1 ? "" : "s"}, kept ${ids.length - removed}.`);
  return outcomes.includes("failed") ? 1 : 0;
}

function pruneOne(paths: AosPaths, key: string, mainRoot: string, record: WorktreeRecord): PruneOutcome {
  if (!existsSync(record.worktreePath)) {
    console.log(`aos: ${record.id} (${record.branch}) is gone from disk; dropping it from the registry.`);
    removeSessionGitDir(sessionGitPaths(paths, key, record.id));
    return "removed";
  }
  const status = treehouseStatus(mainRoot, [record.poolRoot]);
  const ended = leaseEnded(record, status);
  if ((!ended && !isWorktreeClean(record.worktreePath)) || !isMergedInto(mainRoot, workBranch(record))) return "kept";
  const pid = liveHolderPid(record, status);
  if (pid !== undefined) {
    console.log(`aos: ${record.id} (${record.branch}) is still in use by running aos process ${pid}; skipping it.`);
    return "kept";
  }
  try {
    removeOne(paths, key, mainRoot, record, false, status);
    return "removed";
  } catch (error) {
    console.error(`aos: could not remove ${record.id}: ${(error as Error).message}`);
    return "failed";
  }
}

/**
 * Refuses on a still-running agent, uncommitted or unmerged work unless `force`; returns the lease and drops the branch.
 * A lease that already ended outside aos is not returned and its folder is not touched, since treehouse
 * may have handed that folder to another session; only the record's own branch is dropped.
 * Throws only while the lease is still held: once it is returned the caller must drop the record,
 * so a failed branch delete is reported rather than thrown. Callers hold the registry lock.
 */
function removeOne(
  paths: AosPaths,
  key: string,
  mainRoot: string,
  record: WorktreeRecord,
  force: boolean,
  status: readonly TreehouseStatusEntry[] | undefined,
): void {
  const ended = leaseEnded(record, status);
  if (!force) {
    const pid = liveHolderPid(record, status);
    if (pid !== undefined) {
      throw new AosError(`${record.id} is still in use by running aos process ${pid}. Exit that agent first, or run with --force.`);
    }
    if (!ended && existsSync(record.worktreePath) && !isWorktreeClean(record.worktreePath)) {
      throw new AosError(`${record.worktreePath} has uncommitted changes. Commit or discard them, or run with --force.`);
    }
    if (!isMergedInto(mainRoot, workBranch(record))) {
      throw new AosError(`${workBranch(record)} is not merged into the branch checked out in ${mainRoot}. Run "aos worktree merge ${record.id}" first, or use --force.`);
    }
  }
  if (ended) {
    console.error(`aos: the treehouse lease of ${record.id} ended outside aos; leaving ${record.worktreePath} alone.`);
  } else if (existsSync(record.worktreePath)) {
    returnWorktree(record.worktreePath, record.leaseId, record.poolRoot);
  }
  removeSessionGitDir(sessionGitPaths(paths, key, record.id));
  for (const branch of new Set([workBranch(record), record.branch])) {
    try {
      deleteBranch(mainRoot, branch, force);
    } catch (error) {
      console.error(`aos: ${(error as Error).message}`);
    }
  }
  console.log(`aos: removed ${record.id} (${record.branch}).`);
}
