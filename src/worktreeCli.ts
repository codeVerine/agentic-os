import { existsSync } from "node:fs";
import { basename } from "node:path";
import { AosError } from "./errors.ts";
import { deleteBranch, isMergedInto, isWorktreeClean, mainCheckout, mergeLocally } from "./git.ts";
import { type AosPaths, locateProject } from "./paths.ts";
import { projectKey, readRegistry, withRegistryLock, type WorktreeRecord } from "./registry.ts";
import { leaseEnded, liveHolderPid, returnWorktree, treehouseStatus, type TreehouseStatusEntry } from "./treehouse.ts";

const USAGE = `Usage: aos worktree <list|merge|rm|prune> [args]

  aos worktree list          List this project's aos-leased worktrees
  aos worktree merge <id>    Merge a worktree's branch into the main checkout's current branch, locally
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

function listWorktrees(cwd: string, paths: AosPaths): number {
  const { mainRoot, key } = locateMainCheckout(cwd);
  const records = readRegistry(paths, key);
  if (records.length === 0) {
    console.log(`No aos worktrees for ${basename(mainRoot)}.`);
    return 0;
  }
  const live = treehouseStatus(mainRoot);
  for (const record of records) {
    const gone = !existsSync(record.worktreePath);
    const leaseState = gone ? "gone" : (live?.find((e) => e.path === record.worktreePath)?.status ?? "unknown");
    const clean = !gone && isWorktreeClean(record.worktreePath);
    const merged = !gone && isMergedInto(mainRoot, record.branch);
    const flags = gone ? "" : ` (${clean ? "clean" : "dirty"}, ${merged ? "merged" : "unmerged"})`;
    console.log(`${record.id}  ${record.agent.padEnd(8)} ${leaseState.padEnd(9)} ${record.branch}${flags}`);
    console.log(`    ${record.worktreePath}`);
  }
  return 0;
}

function mergeWorktree(id: string, cwd: string, paths: AosPaths): number {
  const { mainRoot, key } = locateMainCheckout(cwd);
  const record = findRecord(readRegistry(paths, key), id);
  mergeLocally(mainRoot, record.branch);
  console.log(`aos: merged ${record.branch} into the branch checked out in ${mainRoot}.`);
  console.log(`aos: run "aos worktree rm ${record.id}" to release its worktree and delete the branch.`);
  return 0;
}

async function removeWorktree(id: string, force: boolean, cwd: string, paths: AosPaths): Promise<number> {
  const { mainRoot, key } = locateMainCheckout(cwd);
  const record = findRecord(readRegistry(paths, key), id);
  removeOne(mainRoot, record, force, treehouseStatus(mainRoot));
  await dropRecords(paths, key, [record.id]);
  return 0;
}

async function pruneWorktrees(cwd: string, paths: AosPaths): Promise<number> {
  const { mainRoot, key } = locateMainCheckout(cwd);
  const records = readRegistry(paths, key);
  const status = treehouseStatus(mainRoot);
  const removedIds: string[] = [];
  let failed = 0;
  for (const record of records) {
    if (!existsSync(record.worktreePath)) {
      console.log(`aos: ${record.id} (${record.branch}) is gone from disk; dropping it from the registry.`);
      removedIds.push(record.id);
      continue;
    }
    if (!isWorktreeClean(record.worktreePath) || !isMergedInto(mainRoot, record.branch)) continue;
    const pid = liveHolderPid(record, status);
    if (pid !== undefined) {
      console.log(`aos: ${record.id} (${record.branch}) is still in use by running aos process ${pid}; skipping it.`);
      continue;
    }
    try {
      removeOne(mainRoot, record, false, status);
      removedIds.push(record.id);
    } catch (error) {
      console.error(`aos: could not remove ${record.id}: ${(error as Error).message}`);
      failed++;
    }
  }
  await dropRecords(paths, key, removedIds);
  const kept = records.length - removedIds.length;
  console.log(`aos: removed ${removedIds.length} worktree${removedIds.length === 1 ? "" : "s"}, kept ${kept}.`);
  return failed === 0 ? 0 : 1;
}

async function dropRecords(paths: AosPaths, key: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await withRegistryLock(paths, key, (records) => ({ records: records.filter((r) => !ids.includes(r.id)), value: undefined }));
}

/**
 * Refuses on a still-running agent, uncommitted or unmerged work unless `force`; returns the lease and drops the branch.
 * A lease that already ended outside aos is not returned and its folder is not touched, since treehouse
 * may have handed that folder to another session; only the record's own branch is dropped.
 * Throws only while the lease is still held: once it is returned the caller must drop the record,
 * so a failed branch delete is reported rather than thrown.
 */
function removeOne(
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
    if (!isMergedInto(mainRoot, record.branch)) {
      throw new AosError(`${record.branch} is not merged into the branch checked out in ${mainRoot}. Run "aos worktree merge ${record.id}" first, or use --force.`);
    }
  }
  if (ended) {
    console.error(`aos: the treehouse lease of ${record.id} ended outside aos; leaving ${record.worktreePath} alone.`);
  } else if (existsSync(record.worktreePath)) {
    returnWorktree(record.worktreePath, record.leaseId);
  }
  try {
    deleteBranch(mainRoot, record.branch, force);
  } catch (error) {
    console.error(`aos: ${(error as Error).message}`);
  }
  console.log(`aos: removed ${record.id} (${record.branch}).`);
}
