import { findClaudeSessionOnHost, findCodexSessionOnHost } from "@ai-hero/sandcastle";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AgentName } from "./agents.ts";
import { AosError } from "./errors.ts";
import { assertGitMetadataMountable, gitCommonDir, sandboxName, type AosPaths, type ProjectLocation } from "./paths.ts";

/** Command name for the treehouse CLI, overridable in tests. */
export const TREEHOUSE_CMD = process.env.AOS_TREEHOUSE_CMD ?? "treehouse";

/**
 * The host's treehouse settings (TREEHOUSE_ROOT and friends), captured when this module loads:
 * cli.ts later strips process.env down to what Sandcastle may see, and without these treehouse
 * would lease from a different pool than the user's own treehouse CLI shows.
 */
const TREEHOUSE_HOST_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key.startsWith("TREEHOUSE_")),
);

function treehouseEnv(): NodeJS.ProcessEnv {
  return { ...process.env, ...TREEHOUSE_HOST_ENV };
}

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
  /** pid of the aos process that last launched an agent here, which may outlive the original lease holder. */
  activePid?: number;
}

export interface WorktreeTarget {
  readonly hostRoot: string;
  readonly sandboxName: string;
  readonly branch: string | undefined;
  readonly created: boolean;
}

/** Where an explicit session id's conversation lives, as far as aos can tell from the host. */
export type SessionLocation =
  | { readonly kind: "worktree"; readonly record: WorktreeRecord }
  | { readonly kind: "main-checkout" }
  | { readonly kind: "not-found" }
  | { readonly kind: "unsupported" };

const STALE_LOCK_MS = 10_000;

/** treehouse's own version string, or undefined when it is not on PATH. For `aos doctor`. */
export function treehouseVersion(cmd: string = TREEHOUSE_CMD): string | undefined {
  const result = spawnSync(cmd, ["--version"], { encoding: "utf8", env: treehouseEnv() });
  return result.error ? undefined : result.stdout.trim();
}

export function assertTreehouseInstalled(agentName: string, cmd: string = TREEHOUSE_CMD): void {
  if (treehouseVersion(cmd) !== undefined) return;
  throw new AosError(
    `aos needs the treehouse CLI to give "aos ${agentName}" its own worktree (https://github.com/kunchenguid/treehouse). ` +
      `Install it and make sure "${cmd}" is on PATH, or run "aos ${agentName} --here" to run in this repository directly instead.`,
  );
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
        return { hostRoot: project.root, sandboxName: project.sandboxName, branch: undefined, created: false };
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
      return { hostRoot: picked.worktreePath, sandboxName: picked.sandboxName, branch: picked.branch, created: false };
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
    return { hostRoot: record.worktreePath, sandboxName: record.sandboxName, branch: record.branch, created: true };
  } catch (error) {
    releaseUnregisteredLease(project.root, lease.path, branchCreated ? branch : undefined);
    throw error;
  }
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
  const has = (...flags: string[]): boolean => args.some((a) => flags.includes(flagName(a)));
  switch (agent) {
    case "claude":
      return has("-r", "--resume", "-c", "--continue");
    case "codex":
      return args[0] === "resume";
    case "opencode":
      return has("-c", "--continue", "-s", "--session");
    case "pi":
      return has("-c", "--continue", "-r", "--resume", "--session", "--session-id");
  }
}

/** A long option's name without any `=value`; any other argument unchanged. */
function flagName(arg: string): string {
  return arg.startsWith("--") ? arg.split("=", 1)[0]! : arg;
}

export function mostRecentlyUsed(records: readonly WorktreeRecord[], agent: AgentName): WorktreeRecord | undefined {
  return records.filter((r) => r.agent === agent).sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))[0];
}

/** The session id named on an explicit `--resume <id>` / `resume <id>` / `--session <id>` argument, if any. */
export function extractExplicitSessionId(agent: AgentName, args: readonly string[]): string | undefined {
  const valueAfter = (flag: string): string | undefined => {
    const i = args.findIndex((a) => flagName(a) === flag);
    if (i < 0) return undefined;
    const arg = args[i]!;
    const value = arg.length > flag.length ? arg.slice(flag.length + 1) : args[i + 1];
    return value !== undefined && value !== "" && !value.startsWith("-") ? value : undefined;
  };
  switch (agent) {
    case "claude":
      return valueAfter("--resume") ?? valueAfter("-r");
    case "codex":
      return args[0] === "resume" && args[1] !== undefined && !args[1].startsWith("-") ? args[1] : undefined;
    case "opencode":
      return valueAfter("-s") ?? valueAfter("--session");
    case "pi":
      return valueAfter("--session") ?? valueAfter("--session-id");
  }
}

/**
 * Finds which of this project's worktrees, or its own checkout (`mainSandboxName`, as used by
 * `--here` and by launches from before worktree support), holds a given session id, by searching that
 * agent's own history under its aos secrets/state directory on the host — the same place a launch
 * mounts into the container. Claude and Codex expose a host-side lookup from Sandcastle directly;
 * Pi's own session files live the same way (one directory per container cwd) but Sandcastle keeps
 * that lookup private, so aos re-implements the same directory scan here. OpenCode keeps sessions
 * in a single SQLite database with no documented per-session-id host index, so it is reported as
 * unsupported rather than guessed at.
 */
export async function findWorktreeForSession(
  agent: AgentName,
  sessionId: string,
  agentStateDir: string,
  records: readonly WorktreeRecord[],
  mainSandboxName: string,
): Promise<SessionLocation> {
  if (agent === "opencode") return { kind: "unsupported" };
  const containerDir = await sessionContainerDir(agent, sessionId, agentStateDir);
  if (containerDir === undefined) return { kind: "not-found" };
  const holds = (name: string): boolean => containerDir.includes(name.slice(-8));
  const record = records.find((r) => r.agent === agent && holds(r.sandboxName));
  if (record) return { kind: "worktree", record };
  return holds(mainSandboxName) ? { kind: "main-checkout" } : { kind: "not-found" };
}

/** The host-side trace of the container directory a session ran in: a directory name or a recorded cwd. */
async function sessionContainerDir(
  agent: Exclude<AgentName, "opencode">,
  sessionId: string,
  agentStateDir: string,
): Promise<string | undefined> {
  switch (agent) {
    case "claude": {
      const found = await findClaudeSessionOnHost(sessionId, join(agentStateDir, "projects")).catch(() => undefined);
      return found?.path ? basename(dirname(found.path)) : undefined;
    }
    case "codex": {
      const found = await findCodexSessionOnHost(sessionId, join(agentStateDir, "sessions")).catch(() => undefined);
      return found?.path ? codexSessionCwd(found.path) : undefined;
    }
    case "pi":
      return findPiSessionFolder(join(agentStateDir, "sessions"), sessionId);
  }
}

/** The `cwd` a Codex rollout file was recorded with, from its leading `session_meta` line's payload. */
function codexSessionCwd(filePath: string): string | undefined {
  try {
    const firstLine = readFileSync(filePath, "utf8")
      .split("\n")
      .find((line) => line.trim() !== "");
    if (!firstLine) return undefined;
    const parsed = JSON.parse(firstLine) as { type?: unknown; payload?: { cwd?: unknown } };
    const cwd = parsed.type === "session_meta" ? parsed.payload?.cwd : undefined;
    return typeof cwd === "string" ? cwd : undefined;
  } catch {
    return undefined;
  }
}

/** Pi session filenames end `_<id>.jsonl` under one directory per container cwd, like Claude's own layout. */
function findPiSessionFolder(sessionsDir: string, sessionId: string): string | undefined {
  if (!existsSync(sessionsDir)) return undefined;
  for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const files = readdirSync(join(sessionsDir, entry.name));
    if (files.some((f) => f.endsWith(`_${sessionId}.jsonl`))) return entry.name;
  }
  return undefined;
}

function leaseWorktree(cwd: string, holder: string): { path: string; leaseId: string } {
  const result = spawnSync(TREEHOUSE_CMD, ["get", "--lease", "--json", "--lease-holder", holder], { cwd, encoding: "utf8", env: treehouseEnv() });
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

/**
 * `treehouse return` releases the lease but leaves the worktree checked out on its branch, so
 * deleting that branch afterward would fail with "used by worktree". Detaching first (always
 * possible: the target tree is the current commit, so it never conflicts with local changes)
 * frees the branch name for `deleteBranch` while leaving everything else in the worktree alone.
 */
export function detachWorktree(worktreePath: string): void {
  const result = spawnSync("git", ["-C", worktreePath, "checkout", "-q", "--detach"], { encoding: "utf8" });
  if (result.status !== 0) throw new AosError(`Could not detach ${worktreePath} from its branch: ${result.stderr.trim()}`);
}

export function returnWorktree(worktreePath: string): void {
  const result = spawnSync(TREEHOUSE_CMD, ["return", worktreePath, "--force"], { encoding: "utf8", env: treehouseEnv() });
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
  const result = spawnSync(TREEHOUSE_CMD, ["status", "--json"], { cwd, encoding: "utf8", env: treehouseEnv() });
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout.trim()) as TreehouseStatusEntry[];
  } catch {
    return undefined;
  }
}

/**
 * pid of a still-running aos process using this worktree: the `aos-<pid>` that holds its treehouse
 * lease, or the one that last resumed it. rm and prune must never take such a worktree back. Both
 * pids outlive their process in the registry and treehouse, so a pid only counts when the process
 * now running under it had already started when aos recorded it; a later reuse of the pid does not.
 * Where `ps` cannot report a start time, any process answering on the pid counts, erring toward
 * keeping a worktree rather than taking back one an agent may still be using.
 */
export function liveHolderPid(record: WorktreeRecord, status: readonly TreehouseStatusEntry[] | undefined): number | undefined {
  const holder = status?.find((e) => e.path === record.worktreePath)?.lease_holder;
  const leasePid = holder?.startsWith("aos-") ? Number(holder.slice("aos-".length)) : undefined;
  if (leasePid !== undefined && startedBy(leasePid, record.createdAt)) return leasePid;
  if (record.activePid !== undefined && startedBy(record.activePid, record.lastUsedAt)) return record.activePid;
  return undefined;
}

function startedBy(pid: number, recordedAt: string): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  const started = result.status === 0 ? Date.parse(result.stdout.trim()) : Number.NaN;
  if (!Number.isNaN(started)) return started <= Date.parse(recordedAt);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
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
