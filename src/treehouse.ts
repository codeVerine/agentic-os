import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AosError } from "./errors.ts";
import { aosRoot } from "./paths.ts";
import type { WorktreeRecord } from "./registry.ts";

/** Pinned treehouse release aos installs and tests against. */
export const TREEHOUSE_PINNED_VERSION = "v2.3.0";
/** Oldest treehouse release aos still works with (`get --lease --json --no-fetch`, `status --json`, `return --if-lease-id`). */
export const TREEHOUSE_MIN_VERSION = "v2.0.0";
const TREEHOUSE_REPO = "kunchenguid/treehouse";

/** Command name for the treehouse CLI, overridable in tests. Kept for compatibility; prefer resolveTreehouseCmd(). */
const TREEHOUSE_CMD = process.env.AOS_TREEHOUSE_CMD ?? "treehouse";

/**
 * The aos root captured when this module loads: cli.ts later strips process.env down to what
 * Sandcastle may see (dropping AOS_ROOT), so the vendored lookup below cannot read it live.
 * An AOS_ROOT still present in process.env (tests, direct API use) wins over this capture.
 */
const AOS_ROOT_AT_LOAD = aosRoot();

/**
 * The host's treehouse settings (TREEHOUSE_ROOT and friends), captured when this module loads:
 * cli.ts later strips process.env down to what Sandcastle may see, and without these treehouse
 * would still find the user's own settings. New aos leases pass `--root` explicitly, which overrides
 * TREEHOUSE_ROOT, so they come from aos's own pool; only worktrees leased before that existed are
 * still looked up in the user's default pool.
 */
const TREEHOUSE_HOST_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key.startsWith("TREEHOUSE_")),
);

function treehouseEnv(): NodeJS.ProcessEnv {
  return { ...process.env, ...TREEHOUSE_HOST_ENV };
}

/** Absolute path of the vendored treehouse binary aos manages itself (`<root>/bin/treehouse`). */
export function vendoredTreehousePath(root?: string): string {
  if (root) return join(root, "bin", "treehouse");
  if (process.env.AOS_ROOT?.trim()) return join(aosRoot(), "bin", "treehouse");
  return join(AOS_ROOT_AT_LOAD, "bin", "treehouse");
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return existsSync(path);
  } catch {
    return false;
  }
}

/**
 * Which treehouse binary to run: an explicit `AOS_TREEHOUSE_CMD` (tests and power users) wins,
 * then the vendored `<AOS_ROOT>/bin/treehouse` when it exists, else `treehouse` on PATH.
 */
export function resolveTreehouseCmd(explicit?: string): string {
  if (explicit) return explicit;
  const override = process.env.AOS_TREEHOUSE_CMD?.trim();
  if (override) return override;
  if (override === undefined) {
    // Fall through to the import-time value for callers that set the env before this module loaded.
    if (TREEHOUSE_CMD !== "treehouse" && isExecutable(TREEHOUSE_CMD)) return TREEHOUSE_CMD;
  }
  const vendored = vendoredTreehousePath();
  if (isExecutable(vendored)) return vendored;
  return "treehouse";
}

export type TreehouseSource = "env" | "vendored" | "path";

/** Where the resolved treehouse binary comes from, for `aos doctor`. */
export function treehouseLocation(cmd: string = resolveTreehouseCmd()): { cmd: string; source: TreehouseSource } {
  if (process.env.AOS_TREEHOUSE_CMD?.trim() || (TREEHOUSE_CMD !== "treehouse" && cmd === TREEHOUSE_CMD)) {
    return { cmd, source: "env" };
  }
  if (cmd === vendoredTreehousePath()) return { cmd, source: "vendored" };
  return { cmd, source: "path" };
}

/** treehouse's own version string, or undefined when it is not installed. For `aos doctor`. */
export function treehouseVersion(cmd: string = resolveTreehouseCmd()): string | undefined {
  const result = spawnSync(cmd, ["--version"], { encoding: "utf8", env: treehouseEnv() });
  if (result.error) return undefined;
  return result.stdout.trim();
}

export function assertTreehouseInstalled(agentName: string, cmd: string = resolveTreehouseCmd()): void {
  if (treehouseVersion(cmd) !== undefined) return;
  throw new AosError(
    `aos needs the treehouse CLI to give "aos ${agentName}" its own worktree (https://github.com/kunchenguid/treehouse). ` +
      `Run "aos treehouse install" to install the pinned ${TREEHOUSE_PINNED_VERSION} into your aos root, or run "aos ${agentName} --here" to run in this repository directly instead.`,
  );
}

/** Compare `vX.Y.Z` tags numerically: negative when a < b, 0 when equal, positive when a > b. */
export function compareTreehouseVersions(a: string, b: string): number {
  const parts = (tag: string): number[] => tag.replace(/^v/i, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** True when `version` (`treehouse vX.Y.Z` or `vX.Y.Z`) is at least the minimum aos supports. */
export function isSupportedTreehouseVersion(version: string | undefined): boolean {
  if (!version) return false;
  const tag = /v\d+\.\d+\.\d+/i.exec(version)?.[0];
  if (!tag) return false;
  return compareTreehouseVersions(tag.toLowerCase().startsWith("v") ? tag : `v${tag}`, TREEHOUSE_MIN_VERSION) >= 0;
}

type AssetPlatform = { os: "darwin" | "linux"; arch: "amd64" | "arm64" };

/** Map Node's platform/arch to treehouse release asset names. Throws for unsupported hosts. */
export function treehouseAssetPlatform(platform: string = process.platform, arch: string = process.arch): AssetPlatform {
  const os = platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : undefined;
  const normalizedArch = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : arch === "amd64" ? "amd64" : undefined;
  if (!os || !normalizedArch) throw new AosError(`treehouse ${TREEHOUSE_PINNED_VERSION} has no build for ${platform}/${arch} (only darwin/linux arm64/amd64).`);
  return { os, arch: normalizedArch };
}

/** Release tarball name, mirroring https://kunchenguid.github.io/treehouse/install.sh. */
export function treehouseAssetName(version: string, platform: string = process.platform, arch: string = process.arch): string {
  const { os, arch: assetArch } = treehouseAssetPlatform(platform, arch);
  return `treehouse-v${version.replace(/^v/, "")}-${os}-${assetArch}.tar.gz`;
}

/** Download URL for a pinned treehouse release. */
export function treehouseDownloadUrl(version: string, platform: string = process.platform, arch: string = process.arch): string {
  return `https://github.com/${TREEHOUSE_REPO}/releases/download/${version}/${treehouseAssetName(version, platform, arch)}`;
}

/** True when a binary's `--version` output is the requested release (boundary-aware: v12.3.0 is not v2.3.0). */
export function binaryMatchesVersion(reported: string | undefined, version: string): boolean {
  if (!reported) return false;
  const want = version.replace(/^v/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\D)${want}($|\\D)`).test(reported);
}

/** Releases aos installs look like `v2.3.0`; anything else is rejected before it reaches a URL or path. */
export function normalizeTreehouseVersion(version: string): string {
  const trimmed = version.trim();
  if (!/^v?\d+\.\d+\.\d+$/.test(trimmed)) throw new AosError(`Expected a release like v2.3.0, got "${version}".`);
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

export interface TreehouseInstallArgs {
  readonly force: boolean;
  /** Requested release; undefined means the pinned one. */
  readonly version?: string;
}

/** Parses `aos treehouse install` flags (`--force`, `--version=X` or `--version X`). */
export function parseTreehouseInstallArgs(flags: readonly string[]): TreehouseInstallArgs {
  const force = flags.includes("--force");
  const versionEq = flags.find((flag) => flag.startsWith("--version="));
  const versionBare = flags.findIndex((flag) => flag === "--version");
  const bareValue = versionBare === -1 ? undefined : flags[versionBare + 1];
  const versionValue = versionEq ? versionEq.slice("--version=".length) : bareValue;
  const unknown = flags.filter(
    (flag, index) => flag !== "--force" && !flag.startsWith("--version=") && flag !== "--version" && !(versionBare !== -1 && index === versionBare + 1),
  );
  const bareDangling = versionBare !== -1 && (bareValue === undefined || bareValue.startsWith("-"));
  if (unknown.length > 0 || bareDangling) {
    throw new AosError("Usage: aos treehouse install [--force] [--version=X]");
  }
  return versionValue ? { force, version: versionValue } : { force };
}

export interface InstallTreehouseOptions {
  /** Directory holding the vendored binary (`<AOS_ROOT>/bin`). Created when missing. */
  readonly binDir: string;
  readonly version?: string;
  readonly force?: boolean;
}

/**
 * Downloads the pinned treehouse release into `binDir/treehouse` (no sudo: the directory is
 * user-owned). The extracted binary is verified before it replaces anything, so a bad download
 * never destroys a working install. Returns whether the binary was freshly installed.
 *
 * shortcut: no sha256 pin — upstream publishes no checksum file, so verification is
 * `--version` reporting the requested version. Pin hashes when they exist.
 */
export function installTreehouse(options: InstallTreehouseOptions): { path: string; fresh: boolean } {
  const version = normalizeTreehouseVersion(options.version ?? TREEHOUSE_PINNED_VERSION);
  const dest = join(options.binDir, "treehouse");
  if (!options.force && binaryMatchesVersion(treehouseVersion(dest), version)) return { path: dest, fresh: false };
  const url = treehouseDownloadUrl(version);
  mkdirSync(options.binDir, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "aos-treehouse-"));
  try {
    const archive = join(tmp, treehouseAssetName(version));
    const download = spawnSync("curl", ["-fsSL", "--max-time", "120", url, "-o", archive], { encoding: "utf8", timeout: 150_000 });
    if (download.error || download.status !== 0) {
      throw new AosError(`downloading treehouse ${version} failed: ${(download.error?.message ?? download.stderr.trim()) || `curl exited ${download.status}`}`);
    }
    const extract = spawnSync("tar", ["xzf", archive, "-C", tmp], { encoding: "utf8" });
    if (extract.error || extract.status !== 0) {
      throw new AosError(`extracting treehouse ${version} failed: ${(extract.error?.message ?? extract.stderr.trim()) || `tar exited ${extract.status}`}`);
    }
    const binary = join(tmp, "treehouse");
    if (!existsSync(binary)) throw new AosError(`treehouse ${version} archive did not contain a treehouse binary.`);
    chmodSync(binary, 0o755);
    const reported = treehouseVersion(binary);
    if (!binaryMatchesVersion(reported, version)) {
      throw new AosError(`downloaded treehouse ${version} reports "${reported || "nothing"}"; refusing to install it.`);
    }
    renameSync(binary, dest);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return { path: dest, fresh: true };
}

/** Global treehouse flags that select a pool: `--root` for a dedicated one, nothing for the user's default pool. */
function poolArgs(root: string | undefined): string[] {
  return root === undefined ? [] : ["--root", root];
}

function runTreehouse(args: readonly string[], options: { cwd?: string } = {}): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(resolveTreehouseCmd(), args, { cwd: options.cwd, encoding: "utf8", env: treehouseEnv() });
  if (result.error) return { ok: false, stdout: "", stderr: result.error.message };
  return { ok: result.status === 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

/**
 * Leases a worktree without fetching origin: aos checks its branch out from the local HEAD, so a
 * launch must not depend on the remote being reachable. The pool is the one under `root`, or the user's
 * default pool when `root` is undefined.
 */
export function leaseWorktree(cwd: string, holder: string, root?: string): { path: string; leaseId: string } {
  const result = spawnSync(resolveTreehouseCmd(), [...poolArgs(root), "get", "--lease", "--json", "--no-fetch", "--lease-holder", holder], {
    cwd,
    encoding: "utf8",
    env: treehouseEnv(),
  });
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
 * Returns the worktree to the pool, which detaches it and discards everything uncommitted. Only done
 * when `leaseId` is still the lease on that folder: treehouse reuses a folder for later leases, so a
 * lease that ended outside aos must never take back the next session's work.
 */
export function returnWorktree(worktreePath: string, leaseId: string, root?: string): void {
  const result = runTreehouse([...poolArgs(root), "return", worktreePath, "--force", "--if-lease-id", leaseId]);
  if (!result.ok) throw new AosError(`treehouse return ${worktreePath} failed: ${(result.stderr || result.stdout).trim()}`);
}

export interface TreehouseStatusEntry {
  readonly name: string;
  readonly path: string;
  readonly status: string;
  readonly lease_id: string;
  readonly lease_holder: string;
}

function poolStatus(cwd: string, root: string | undefined): TreehouseStatusEntry[] | undefined {
  const result = spawnSync(resolveTreehouseCmd(), [...poolArgs(root), "status", "--json"], { cwd, encoding: "utf8", env: treehouseEnv() });
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout.trim()) as TreehouseStatusEntry[];
  } catch {
    return undefined;
  }
}

/**
 * Live status of every pool in `roots` (undefined is the user's default pool), concatenated, or
 * undefined when treehouse is not installed or any one call fails: a pool aos could not read must not
 * look like one whose leases ended.
 */
export function treehouseStatus(cwd: string, roots: readonly (string | undefined)[] = [undefined]): TreehouseStatusEntry[] | undefined {
  const all: TreehouseStatusEntry[] = [];
  for (const root of new Set(roots)) {
    const status = poolStatus(cwd, root);
    if (status === undefined) return undefined;
    all.push(...status);
  }
  return all;
}

/** Treehouse lists the folder under a different lease, so it may now belong to another session. */
export function leaseEnded(record: WorktreeRecord, status: readonly TreehouseStatusEntry[] | undefined): boolean {
  const entry = status?.find((e) => e.path === record.worktreePath);
  return entry !== undefined && entry.lease_id !== record.leaseId;
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
  const entry = status?.find((e) => e.path === record.worktreePath);
  const holder = entry?.lease_id === record.leaseId ? entry.lease_holder : undefined;
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
