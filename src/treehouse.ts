import { spawnSync } from "node:child_process";
import { AosError } from "./errors.ts";
import type { WorktreeRecord } from "./registry.ts";

/** Command name for the treehouse CLI, overridable in tests. */
const TREEHOUSE_CMD = process.env.AOS_TREEHOUSE_CMD ?? "treehouse";

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

export function leaseWorktree(cwd: string, holder: string): { path: string; leaseId: string } {
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
