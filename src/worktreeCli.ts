import { existsSync } from "node:fs";
import { AosError } from "./errors.ts";
import { locateProject } from "./paths.ts";
import type { AosPaths } from "./paths.ts";
import {
  deleteBranch,
  detachWorktree,
  isMergedInto,
  isWorktreeClean,
  mergeLocally,
  projectKey,
  readRegistry,
  returnWorktree,
  treehouseStatus,
  withRegistryLock,
  type WorktreeRecord,
} from "./worktree.ts";

const USAGE = `Usage: aos worktree <list|merge|rm|prune> [args]

  aos worktree list          List this project's aos-leased worktrees
  aos worktree merge <id>    Merge a worktree's branch into the current branch here, locally
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

function listWorktrees(cwd: string, paths: AosPaths): number {
  const project = locateProject(cwd);
  const key = projectKey(project.root);
  const records = readRegistry(paths, key);
  if (records.length === 0) {
    console.log(`No aos worktrees for ${project.name}.`);
    return 0;
  }
  const live = treehouseStatus(project.root);
  for (const record of records) {
    const gone = !existsSync(record.worktreePath);
    const leaseState = gone ? "gone" : (live?.find((e) => e.path === record.worktreePath)?.status ?? "unknown");
    const clean = !gone && isWorktreeClean(record.worktreePath);
    const merged = !gone && isMergedInto(project.root, record.branch);
    const flags = gone ? "" : ` (${clean ? "clean" : "dirty"}, ${merged ? "merged" : "unmerged"})`;
    console.log(`${record.id}  ${record.agent.padEnd(8)} ${leaseState.padEnd(9)} ${record.branch}${flags}`);
    console.log(`    ${record.worktreePath}`);
  }
  return 0;
}

function mergeWorktree(id: string, cwd: string, paths: AosPaths): number {
  const project = locateProject(cwd);
  const key = projectKey(project.root);
  const record = findRecord(readRegistry(paths, key), id);
  mergeLocally(project.root, record.branch);
  console.log(`aos: merged ${record.branch} into the branch checked out in ${project.root}.`);
  console.log(`aos: run "aos worktree rm ${record.id}" to release its worktree and delete the branch.`);
  return 0;
}

async function removeWorktree(id: string, force: boolean, cwd: string, paths: AosPaths): Promise<number> {
  const project = locateProject(cwd);
  const key = projectKey(project.root);
  return withRegistryLock(paths, key, (records) => {
    const record = findRecord(records, id);
    removeOne(project.root, record, force);
    return { records: records.filter((r) => r.id !== record.id), value: 0 };
  });
}

async function pruneWorktrees(cwd: string, paths: AosPaths): Promise<number> {
  const project = locateProject(cwd);
  const key = projectKey(project.root);
  return withRegistryLock(paths, key, (records) => {
    const kept: WorktreeRecord[] = [];
    let removed = 0;
    for (const record of records) {
      if (!existsSync(record.worktreePath)) {
        console.log(`aos: ${record.id} (${record.branch}) is gone from disk; dropping it from the registry.`);
        removed++;
        continue;
      }
      if (isWorktreeClean(record.worktreePath) && isMergedInto(project.root, record.branch)) {
        removeOne(project.root, record, false);
        removed++;
        continue;
      }
      kept.push(record);
    }
    console.log(`aos: removed ${removed} worktree${removed === 1 ? "" : "s"}, kept ${kept.length}.`);
    return { records: kept, value: 0 };
  });
}

/** Refuses on uncommitted or unmerged work unless `force`; returns the lease and drops the branch. */
function removeOne(mainRoot: string, record: WorktreeRecord, force: boolean): void {
  if (!force) {
    if (existsSync(record.worktreePath) && !isWorktreeClean(record.worktreePath)) {
      throw new AosError(`${record.worktreePath} has uncommitted changes. Commit or discard them, or run with --force.`);
    }
    if (!isMergedInto(mainRoot, record.branch)) {
      throw new AosError(`${record.branch} is not merged into the branch checked out in ${mainRoot}. Run "aos worktree merge ${record.id}" first, or use --force.`);
    }
  }
  if (existsSync(record.worktreePath)) {
    detachWorktree(record.worktreePath);
    returnWorktree(record.worktreePath);
  }
  try {
    deleteBranch(mainRoot, record.branch, force);
  } catch (error) {
    if (!force) throw error;
    console.error(`aos: ${(error as Error).message}`);
  }
  console.log(`aos: removed ${record.id} (${record.branch}).`);
}
