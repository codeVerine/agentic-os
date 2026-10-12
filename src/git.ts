import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import { AosError } from "./errors.ts";

/**
 * Env additions that stop a `git` process from running a repository's own hooks or spawning an
 * fsmonitor daemon, via the `GIT_CONFIG_*` env vars git reads as if they were `-c` overrides.
 * Shared by every host-side git call aos makes, directly or through Sandcastle, so a hook an agent
 * committed into a project (including one of its own worktrees) never runs on the Mac.
 */
export function hookSafeGitEnv(): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "core.fsmonitor",
    GIT_CONFIG_VALUE_1: "false",
  };
}

/**
 * Runs `git` on the host with the same hook and fsmonitor protection aos gives Sandcastle's own
 * git calls (see `hookSafeGitEnv`), so every host-side git call aos makes shares it, no matter the
 * caller's own `env` or the ambient process env it runs under.
 */
export function spawnGit(
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding = { encoding: "utf8" },
): SpawnSyncReturns<string> {
  return spawnSync("git", args, { ...options, env: { ...process.env, ...options.env, ...hookSafeGitEnv() } });
}

/** Trimmed stdout of `git -C dir ...args`, or "" when git fails. */
export function gitOrEmpty(dir: string, ...args: string[]): string {
  const result = spawnGit(["-C", dir, ...args]);
  return result.status === 0 ? result.stdout.trim() : "";
}

/** Trimmed stdout of `git -C dir ...args`; throws with git's stderr when it fails. */
export function git(dir: string, ...args: string[]): string {
  const result = spawnGit(["-C", dir, ...args]);
  if (result.status !== 0) throw new AosError(`git ${args.join(" ")} failed in ${dir}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/**
 * The repository's main checkout, whichever of its worktrees `root` is. Merge checks, merges and branch
 * deletes must run there: from inside an aos worktree, that worktree's own HEAD always contains its branch.
 */
export function mainCheckout(root: string): string {
  const first = git(root, "worktree", "list", "--porcelain").split("\n")[0] ?? "";
  if (!first.startsWith("worktree ")) throw new AosError(`Could not resolve the main checkout for ${root}.`);
  return first.slice("worktree ".length);
}

/** Working tree has no uncommitted changes. */
export function isWorktreeClean(worktreePath: string): boolean {
  const result = spawnGit(["-C", worktreePath, "status", "--porcelain"]);
  return result.status === 0 && result.stdout.trim() === "";
}

/** `branch`'s tip is already an ancestor of `into`'s current HEAD. */
export function isMergedInto(into: string, branch: string): boolean {
  const result = spawnGit(["-C", into, "merge-base", "--is-ancestor", branch, "HEAD"]);
  return result.status === 0;
}

export function checkoutNewBranch(worktreePath: string, branch: string, baseRev: string): void {
  const result = spawnGit(["-C", worktreePath, "checkout", "-q", "-b", branch, baseRev]);
  if (result.status !== 0) throw new AosError(`Could not create branch ${branch} in ${worktreePath}: ${result.stderr.trim()}`);
}

/**
 * `treehouse return` releases the lease but leaves the worktree checked out on its branch, so
 * deleting that branch afterward would fail with "used by worktree". Detaching first (always
 * possible: the target tree is the current commit, so it never conflicts with local changes)
 * frees the branch name for `deleteBranch` while leaving everything else in the worktree alone.
 */
export function detachWorktree(worktreePath: string): void {
  const result = spawnGit(["-C", worktreePath, "checkout", "-q", "--detach"]);
  if (result.status !== 0) throw new AosError(`Could not detach ${worktreePath} from its branch: ${result.stderr.trim()}`);
}

export function mergeLocally(mainRoot: string, branch: string): void {
  const result = spawnGit(["-C", mainRoot, "merge", "--no-edit", branch]);
  if (result.status !== 0) throw new AosError(`git merge ${branch} failed in ${mainRoot}: ${(result.stderr || result.stdout).trim()}`);
}

export function deleteBranch(mainRoot: string, branch: string, force: boolean): void {
  const result = spawnGit(["-C", mainRoot, "branch", force ? "-D" : "-d", branch]);
  if (result.status !== 0) throw new AosError(`git branch ${force ? "-D" : "-d"} ${branch} failed: ${result.stderr.trim()}`);
}
