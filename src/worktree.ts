import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentName } from "./agents.ts";
import { checkoutNewBranch, deleteBranch, detachWorktree, git } from "./git.ts";
import { assertGitMetadataMountable, type AosPaths, type ProjectLocation, sandboxName } from "./paths.ts";
import { projectKey, readRegistry, type WorktreeRecord, withRegistryLock } from "./registry.ts";
import { detectResumeIntent, extractExplicitSessionId, findWorktreeForSession, mostRecentlyUsed } from "./resume.ts";
import { assertTreehouseInstalled, leaseWorktree, returnWorktree } from "./treehouse.ts";

export interface WorktreeTarget {
  readonly hostRoot: string;
  readonly sandboxName: string;
  readonly branch: string | undefined;
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
        return { hostRoot: project.root, sandboxName: project.sandboxName, branch: undefined };
      } else {
        console.error(`aos: no aos worktree for this project has a ${agentName} session "${explicitId}"; leasing a new worktree.`);
      }
    } else {
      picked = mostRecentlyUsed(records, agentName);
    }

    if (picked && existsSync(picked.worktreePath)) {
      await withRegistryLock(paths, key, (all) => {
        const record = all.find((r) => r.id === picked?.id);
        if (record) {
          record.lastUsedAt = new Date().toISOString();
          record.activePid = process.pid;
        }
        return { records: all, value: undefined };
      });
      return { hostRoot: picked.worktreePath, sandboxName: picked.sandboxName, branch: picked.branch };
    }
    if (picked) console.error(`aos: the worktree for that ${agentName} session is gone from disk; leasing a new one.`);
    else if (!explicitId) console.error(`aos: no existing ${agentName} worktree found for this project yet; leasing a new one.`);
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
      baseRev,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      leaseId: lease.leaseId,
      activePid: process.pid,
    };
    await withRegistryLock(paths, key, (records) => ({ records: [...records, record], value: undefined }));
    return { hostRoot: record.worktreePath, sandboxName: record.sandboxName, branch: record.branch };
  } catch (error) {
    releaseUnregisteredLease(project.root, lease.path, branchCreated ? branch : undefined);
    throw error;
  }
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
function releaseUnregisteredLease(mainRoot: string, worktreePath: string, branch: string | undefined): void {
  const steps = branch
    ? [() => detachWorktree(worktreePath), () => returnWorktree(worktreePath), () => deleteBranch(mainRoot, branch, true)]
    : [() => returnWorktree(worktreePath)];
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
