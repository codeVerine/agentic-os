import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "node:path";
import type { AgentName } from "./agents.ts";
import { AosError } from "./errors.ts";
import { assertGitMetadataMountable, gitCommonDir, sandboxName, type AosPaths, type ProjectLocation } from "./paths.ts";

/** Command name for the treehouse CLI, overridable in tests. */
export const TREEHOUSE_CMD = process.env.AOS_TREEHOUSE_CMD ?? "treehouse";

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
  /** Commit the branch was created from. */
  readonly baseRev: string;
  readonly createdAt: string;
  lastUsedAt: string;
  /** treehouse lease id, held from creation until `aos worktree rm`. */
  readonly leaseId: string;
}

export interface WorktreeTarget {
  readonly hostRoot: string;
  readonly sandboxName: string;
  readonly branch: string;
  readonly created: boolean;
}

const STALE_LOCK_MS = 10_000;

export function assertTreehouseInstalled(agentName: string): void {
  const result = spawnSync(TREEHOUSE_CMD, ["--version"], { encoding: "utf8" });
  if (result.error) {
    throw new AosError(
      `aos needs the treehouse CLI to give "aos ${agentName}" its own worktree (https://github.com/kunchenguid/treehouse). ` +
        `Install it and make sure "${TREEHOUSE_CMD}" is on PATH, or run "aos ${agentName} --here" to run in this repository directly instead.`,
    );
  }
}

/**
 * Resolves where an `aos <agent>` launch should run: an existing worktree when the agent's own
 * args ask to resume or continue and one exists for this project, otherwise a freshly leased one.
 * Callers pass `--here` launches around this entirely; see launch.ts.
 */
export async function resolveWorktreeTarget(
  agentName: AgentName,
  agentArgs: readonly string[],
  project: ProjectLocation,
  paths: AosPaths,
): Promise<WorktreeTarget> {
  assertTreehouseInstalled(agentName);
  const key = projectKey(project.root);

  if (detectResumeIntent(agentName, agentArgs)) {
    const match = await withRegistryLock(paths, key, (records) => {
      const found = mostRecentlyUsed(records, agentName);
      if (found && existsSync(found.worktreePath)) {
        found.lastUsedAt = new Date().toISOString();
        return { records, value: found };
      }
      return { records, value: undefined };
    });
    if (match) return { hostRoot: match.worktreePath, sandboxName: match.sandboxName, branch: match.branch, created: false };
    console.error(`aos: no existing ${agentName} worktree found for this project yet; leasing a new one.`);
  }

  const holder = `aos-${process.pid}`;
  const lease = leaseWorktree(project.root, holder);
  const baseRev = git(project.root, "rev-parse", "HEAD");
  const id = newId();
  const branch = `aos/${agentName}/${id}`;
  checkoutNewBranch(lease.path, branch, baseRev);
  assertGitMetadataMountable(lease.path);
  const boxName = sandboxName(project.name, `${key}::${branch}`);
  const record: WorktreeRecord = {
    id,
    agent: agentName,
    branch,
    worktreePath: lease.path,
    sandboxName: boxName,
    baseRev,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    leaseId: lease.leaseId,
  };
  await withRegistryLock(paths, key, (records) => ({ records: [...records, record], value: record }));
  return { hostRoot: record.worktreePath, sandboxName: record.sandboxName, branch: record.branch, created: true };
}

/** Stable identity for "this repository", the same from the main checkout or any of its worktrees. */
export function projectKey(root: string): string {
  return createHash("sha256").update(gitCommonDir(root)).digest("hex").slice(0, 16);
}

function newId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").slice(0, 15);
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

/**
 * Whether this agent's own args ask it to resume or continue a prior conversation. Every agent
 * scopes that lookup to its current working directory (confirmed against each CLI: Claude's
 * `--resume`/`-c`/`--continue`, Codex's `resume` subcommand, OpenCode's `-c`/`--session`, Pi's
 * `-c`/`-r`/`--session[-id]`), so landing the launch in the right worktree is enough; aos does not
 * need to parse or track individual session ids.
 */
export function detectResumeIntent(agent: AgentName, args: readonly string[]): boolean {
  switch (agent) {
    case "claude":
      return args.some((a) => a === "--resume" || a === "-c" || a === "--continue");
    case "codex":
      return args[0] === "resume";
    case "opencode":
      return args.some((a) => a === "-c" || a === "--continue" || a === "-s" || a === "--session");
    case "pi":
      return args.some(
        (a) => a === "-c" || a === "--continue" || a === "-r" || a === "--resume" || a === "--session" || a === "--session-id",
      );
  }
}

export function mostRecentlyUsed(records: readonly WorktreeRecord[], agent: AgentName): WorktreeRecord | undefined {
  return records.filter((r) => r.agent === agent).sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))[0];
}

function leaseWorktree(cwd: string, holder: string): { path: string; leaseId: string } {
  const result = spawnSync(TREEHOUSE_CMD, ["get", "--lease", "--json", "--lease-holder", holder], { cwd, encoding: "utf8" });
  if (result.error) throw new AosError(`treehouse get --lease failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new AosError(`treehouse get --lease failed: ${(result.stderr || result.stdout).trim()}`);
  }
  let parsed: { path?: string; lease_id?: string };
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    throw new AosError(`treehouse get --lease printed unexpected output: ${result.stdout.trim()}`);
  }
  if (!parsed.path || !parsed.lease_id) {
    throw new AosError(`treehouse get --lease did not return a worktree path and lease id: ${result.stdout.trim()}`);
  }
  return { path: parsed.path, leaseId: parsed.lease_id };
}

export function returnWorktree(worktreePath: string): void {
  const result = spawnSync(TREEHOUSE_CMD, ["return", worktreePath, "--force"], { encoding: "utf8" });
  if (result.status !== 0) throw new AosError(`treehouse return ${worktreePath} failed: ${(result.stderr || result.stdout).trim()}`);
}

export interface TreehouseStatusEntry {
  readonly name: string;
  readonly path: string;
  readonly status: string;
  readonly lease_id: string;
  readonly lease_holder: string;
}

/** Live pool status, or undefined when treehouse is not installed or the call fails. */
export function treehouseStatus(cwd: string): TreehouseStatusEntry[] | undefined {
  const result = spawnSync(TREEHOUSE_CMD, ["status", "--json"], { cwd, encoding: "utf8" });
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout.trim()) as TreehouseStatusEntry[];
  } catch {
    return undefined;
  }
}

function checkoutNewBranch(worktreePath: string, branch: string, baseRev: string): void {
  const result = spawnSync("git", ["-C", worktreePath, "checkout", "-q", "-b", branch, baseRev], { encoding: "utf8" });
  if (result.status !== 0) throw new AosError(`Could not create branch ${branch} in ${worktreePath}: ${result.stderr.trim()}`);
}

export function git(dir: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new AosError(`git ${args.join(" ")} failed in ${dir}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** Working tree has no uncommitted changes. */
export function isWorktreeClean(worktreePath: string): boolean {
  const result = spawnSync("git", ["-C", worktreePath, "status", "--porcelain"], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() === "";
}

/** `branch`'s tip is already an ancestor of `into`'s current HEAD. */
export function isMergedInto(into: string, branch: string): boolean {
  const result = spawnSync("git", ["-C", into, "merge-base", "--is-ancestor", branch, "HEAD"], { encoding: "utf8" });
  return result.status === 0;
}

export function mergeLocally(mainRoot: string, branch: string): void {
  const result = spawnSync("git", ["-C", mainRoot, "merge", "--no-edit", branch], { encoding: "utf8" });
  if (result.status !== 0) throw new AosError(`git merge ${branch} failed in ${mainRoot}: ${(result.stderr || result.stdout).trim()}`);
}

export function deleteBranch(mainRoot: string, branch: string, force: boolean): void {
  const result = spawnSync("git", ["-C", mainRoot, "branch", force ? "-D" : "-d", branch], { encoding: "utf8" });
  if (result.status !== 0) throw new AosError(`git branch ${force ? "-D" : "-d"} ${branch} failed: ${result.stderr.trim()}`);
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
  mkdirSync(paths.worktrees, { recursive: true });
  const file = registryFile(paths, key);
  const staging = `${file}.aos-${process.pid}.tmp`;
  writeFileSync(staging, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
  renameSync(staging, file);
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
