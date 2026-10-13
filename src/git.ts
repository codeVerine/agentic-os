import { spawn, spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
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
 * Env that makes git trust exactly `paths` as `safe.directory`, for the container's git. A bind mount's
 * files are not owned by the container user, so git refuses them with "dubious ownership" unless the path
 * is listed. The env vars are command-line scope, which git honours for `safe.directory`, and they spare
 * aos from quoting host paths into a `git config` shell command.
 */
export function safeDirectoryEnv(paths: readonly string[]): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(paths.length) };
  paths.forEach((path, index) => {
    env[`GIT_CONFIG_KEY_${index}`] = "safe.directory";
    env[`GIT_CONFIG_VALUE_${index}`] = path;
  });
  return env;
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

export interface GitResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * `spawnGit` without blocking the event loop, for work that runs while an agent's terminal session is
 * being relayed by this same process.
 */
export function spawnGitAsync(args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...hookSafeGitEnv() } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => resolve({ status: null, stdout, stderr: error.message }));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
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

/**
 * Working tree has no uncommitted changes, new files included: `--untracked-files=all` overrides a
 * `status.showUntrackedFiles=no` config that would otherwise hide them.
 */
export function isWorktreeClean(worktreePath: string): boolean {
  const result = spawnGit(["-C", worktreePath, "status", "--porcelain", "--untracked-files=all"]);
  return result.status === 0 && result.stdout.trim() === "";
}

/** Name of the branch checked out in `worktreePath`, or "" on a detached HEAD or when git fails. */
export function currentBranch(worktreePath: string): string {
  return gitOrEmpty(worktreePath, "symbolic-ref", "--short", "--quiet", "HEAD");
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

export function mergeLocally(mainRoot: string, branch: string): void {
  const result = spawnGit(["-C", mainRoot, "merge", "--no-edit", branch]);
  if (result.status !== 0) throw new AosError(`git merge ${branch} failed in ${mainRoot}: ${(result.stderr || result.stdout).trim()}`);
}

export function deleteBranch(mainRoot: string, branch: string, force: boolean): void {
  const result = spawnGit(["-C", mainRoot, "branch", force ? "-D" : "-d", branch]);
  if (result.status !== 0) throw new AosError(`git branch ${force ? "-D" : "-d"} ${branch} failed: ${result.stderr.trim()}`);
}
