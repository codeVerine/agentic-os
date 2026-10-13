import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentName } from "./agents.ts";
import { AosError } from "./errors.ts";
import { checkoutNewBranch, currentBranch, deleteBranch, git } from "./git.ts";
import { assertGitMetadataMountable, type AosPaths, type ProjectLocation, sandboxName } from "./paths.ts";
import { projectKey, readRegistry, type WorktreeRecord, withRegistryLock } from "./registry.ts";
import { detectResumeIntent, extractExplicitSessionId, findWorktreeForSession, mostRecentlyUsed } from "./resume.ts";
import { assertTreehouseInstalled, leaseWorktree, liveHolderPid, returnWorktree, treehouseStatus } from "./treehouse.ts";

export interface WorktreeTarget {
  readonly hostRoot: string;
  readonly sandboxName: string;
  readonly branch: string | undefined;
  /** Directory the agent starts in, relative to `hostRoot`, POSIX separators, "" at the root. */
  readonly subdir: string;
}

/**
 * Resolves where an `aos <agent>` launch should run: an existing worktree when the agent's own
 * args ask to resume or continue and one exists for this project, this checkout itself when an
 * explicit session id ran here rather than in an aos worktree, otherwise a freshly leased one.
 * Callers pass `--here` launches around this entirely; see launch.ts.
 */
export async function resolveWorktreeTarget(
  agentName: AgentName,
  agentArgs: readonly string[],
  project: ProjectLocation,
  paths: AosPaths,
  agentStateDir: string,
): Promise<WorktreeTarget> {
  assertTreehouseInstalled(agentName);
  const key = projectKey(project.root);

  if (detectResumeIntent(agentName, agentArgs)) {
    const records = readRegistry(paths, key);
    const explicitId = extractExplicitSessionId(agentName, agentArgs);
    let picked: WorktreeRecord | undefined;

    if (explicitId) {
      const found = await findWorktreeForSession(agentName, explicitId, agentStateDir, records, project.sandboxName);
      if (found.kind === "unsupported") {
        console.error(
          `aos: can't map a ${agentName} session id to a worktree automatically (no reliable per-session host index for ${agentName}); using the most recently used ${agentName} worktree for this project instead.`,
        );
        picked = mostRecentlyUsed(records, agentName);
      } else if (found.kind === "worktree") {
        picked = found.record;
      } else if (found.kind === "main-checkout") {
        console.error(`aos: ${agentName} session "${explicitId}" ran in ${project.root} itself, not in an aos worktree; resuming it there.`);
        return { hostRoot: project.root, sandboxName: project.sandboxName, branch: undefined, subdir: project.subdir };
      } else {
        console.error(`aos: no aos worktree for this project has a ${agentName} session "${explicitId}"; leasing a new worktree.`);
      }
    } else {
      picked = mostRecentlyUsed(records, agentName);
    }

    if (picked) {
      const claim = await claimWorktree(paths, key, picked.id, project.root);
      if (claim.kind === "claimed") {
        const { record } = claim;
        return { hostRoot: record.worktreePath, sandboxName: record.sandboxName, branch: record.branch, subdir: record.subdir ?? "" };
      }
      console.error(
        claim.kind === "ended"
          ? `aos: the treehouse lease of that ${agentName} worktree ended outside aos, so its folder may belong to another session now; leasing a new one.`
          : `aos: the worktree for that ${agentName} session is gone from disk; leasing a new one.`,
      );
    } else if (!explicitId) console.error(`aos: no existing ${agentName} worktree found for this project yet; leasing a new one.`);
  }

  const holder = `aos-${process.pid}`;
  const lease = leaseWorktree(project.root, holder);
  const id = newId();
  const branch = `aos/${agentName}/${id}`;
  let branchCreated = false;
  try {
    const baseRev = git(project.root, "rev-parse", "HEAD");
    checkoutNewBranch(lease.path, branch, baseRev);
    branchCreated = true;
    assertGitMetadataMountable(lease.path);
    const record: WorktreeRecord = {
      id,
      agent: agentName,
      branch,
      worktreePath: lease.path,
      sandboxName: sandboxName(project.name, `${key}::${branch}`),
      subdir: project.subdir,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      leaseId: lease.leaseId,
      activePid: process.pid,
    };
    await withRegistryLock(paths, key, (records) => ({ records: [...records, record], value: undefined }));
    return { hostRoot: record.worktreePath, sandboxName: record.sandboxName, branch: record.branch, subdir: project.subdir };
  } catch (error) {
    releaseUnregisteredLease(project.root, lease, branchCreated ? branch : undefined);
    throw error;
  }
}

type Claim = { readonly kind: "claimed"; readonly record: WorktreeRecord } | { readonly kind: "ended" } | { readonly kind: "gone" };

/**
 * Checks that a recorded worktree is free and still this session's, and marks it in use by this process,
 * all under the registry lock so two resumes (or a resume and `aos worktree rm`) never both take it.
 * Throws when another aos process runs in it, or when treehouse cannot confirm that the lease and the
 * branch checked out are the ones aos recorded: guessing could put an old conversation into the files
 * of whichever session treehouse gave the folder to since.
 */
async function claimWorktree(paths: AosPaths, key: string, id: string, projectRoot: string): Promise<Claim> {
  return withRegistryLock(paths, key, (records): { records: WorktreeRecord[]; value: Claim } => {
    const record = records.find((r) => r.id === id);
    if (!record || !existsSync(record.worktreePath)) return { records, value: { kind: "gone" } };
    const status = treehouseStatus(projectRoot);
    const pid = liveHolderPid(record, status);
    if (pid !== undefined) {
      throw new AosError(
        `The ${record.agent} worktree ${record.id} (${record.branch}) is in use by running aos process ${pid}. Exit that session first, or start a new one without a resume flag.`,
      );
    }
    const cannotVerify = (why: string): AosError =>
      new AosError(`Cannot resume ${record.branch}: ${why}, so aos cannot verify that ${record.worktreePath} is still its worktree. Fix that, or start a new session without a resume flag.`);
    if (status === undefined) throw cannotVerify("treehouse status is unavailable");
    const entry = status.find((e) => e.path === record.worktreePath);
    if (entry === undefined) throw cannotVerify("treehouse does not list that folder in this project's pool");
    if (entry.lease_id !== record.leaseId) return { records, value: { kind: "ended" } };
    const branch = currentBranch(record.worktreePath);
    if (branch !== record.branch) {
      throw cannotVerify(`the folder is not on its branch (${branch === "" ? "a detached HEAD" : branch} is checked out there)`);
    }
    record.lastUsedAt = new Date().toISOString();
    record.activePid = process.pid;
    return { records, value: { kind: "claimed", record } };
  });
}

/**
 * The container directory the agent starts in: the launch directory's counterpart inside the
 * mounted checkout, or its root when that subdirectory does not exist there (an untracked or
 * ignored directory, or one newer than the worktree's commit).
 */
export function containerWorkdir(sandboxProjectRoot: string, hostRoot: string, subdir: string): string {
  if (!subdir) return sandboxProjectRoot;
  if (statSync(join(hostRoot, subdir), { throwIfNoEntry: false })?.isDirectory()) return `${sandboxProjectRoot}/${subdir}`;
  console.error(`aos: ${subdir} does not exist in ${hostRoot}; starting the agent at the worktree root instead.`);
  return sandboxProjectRoot;
}

/** Undoes a lease whose setup failed before it was registered, so the pool never leaks it. */
function releaseUnregisteredLease(mainRoot: string, lease: { path: string; leaseId: string }, branch: string | undefined): void {
  const steps = [() => returnWorktree(lease.path, lease.leaseId)];
  if (branch) steps.push(() => deleteBranch(mainRoot, branch, true));
  for (const step of steps) {
    try {
      step();
    } catch (error) {
      console.error(`aos: cleanup after a failed launch: ${(error as Error).message}`);
    }
  }
}

function newId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}
