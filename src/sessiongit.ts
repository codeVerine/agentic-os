import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { hostIds, IMAGE } from "./docker.ts";
import { AosError } from "./errors.ts";
import { withFileLock } from "./fsutil.ts";
import { type GitResult, spawnGit, spawnGitAsync } from "./git.ts";
import { type AosPaths } from "./paths.ts";
import { readRegistry, withRegistryLock, type WorktreeRecord } from "./registry.ts";

/**
 * A worktree session's private git directory. The treehouse worktree folder stays where treehouse put it
 * and keeps its approved `.git` file on the Mac. Inside the container a different `.git` file points at
 * `gitDir`, which has its own config, hooks, refs and index and borrows the repository's objects read-only.
 * The container never gets a writable path into the repository's own git directory, and host git never opens
 * `gitDir`: the branch comes back as a bundle made by a throwaway container.
 */
export interface SessionGit {
  /** The worktree record's id, which names the session's git directory. */
  readonly id: string;
  readonly gitDir: string;
  /** A one-line `.git` file (`gitdir: <gitDir>`), mounted read-only over the worktree's own `.git`. */
  readonly gitFile: string;
}

/** Container path the repository's git directory is mounted at, read-only, as the session's `host` remote. */
export const HOST_GIT_MOUNT = "/mnt/aos-host-git";
/** Name of the session remote that fetches the repository's own branches. */
export const HOST_REMOTE_NAME = "host";
const BUNDLE_TIMEOUT_MS = 120_000;
/** Command name for the docker CLI, overridable in tests. */
const DOCKER_CMD = process.env.AOS_DOCKER_CMD ?? "docker";
const MAX_REF_BYTES = 256;
const MAX_PACKED_REFS_BYTES = 8 * 1024 * 1024;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function sessionGitPaths(paths: AosPaths, key: string, id: string): SessionGit {
  const dir = join(paths.gitdirs, key);
  return { id, gitDir: join(dir, `${id}.git`), gitFile: join(dir, `${id}.gitfile`) };
}

/** Git directories the repository borrows objects from, its own first: each is a read-only mount of the session. */
export function objectDirs(commonDir: string): string[] {
  const found: string[] = [];
  const visit = (objects: string, depth: number): void => {
    if (found.includes(objects) || depth > 5) return;
    found.push(objects);
    let text: string;
    try {
      text = readFileSync(join(objects, "info", "alternates"), "utf8");
    } catch {
      return;
    }
    for (const line of text.split("\n")) {
      const entry = line.trim();
      if (entry !== "" && !entry.startsWith("#")) visit(resolve(objects, entry), depth + 1);
    }
  };
  visit(join(commonDir, "objects"), 0);
  return found;
}

function assertMountable(path: string): void {
  if (path.includes(":") || path.includes(",")) {
    throw new AosError(`Path ${path} contains ":" or ",", which Docker bind mounts cannot express.`);
  }
}

function gitIn(gitDir: string, args: readonly string[], what: string): string {
  const result = spawnGit(["--git-dir", gitDir, ...args]);
  if (result.status !== 0) throw new AosError(`${what} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** Copies the regular files of `from` into `to`, keeping modes and skipping `*.sample`, symlinks and anything unreadable. */
function copyApprovedFiles(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  let names: string[];
  try {
    names = readdirSync(from);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.endsWith(".sample")) continue;
    const source = join(from, name);
    try {
      const stat = statSync(source);
      if (!stat.isFile()) continue;
      copyFileSync(source, join(to, name));
      chmodSync(join(to, name), stat.mode & 0o777);
    } catch {
      // A dangling symlink or an unreadable file is not part of the approved setup.
    }
  }
}

export interface CreateSessionGitDirOptions {
  /** Any checkout of the repository, or its git directory's owner; used to read object format and refs. */
  readonly mainRoot: string;
  readonly commonDir: string;
  readonly worktreePath: string;
  readonly session: SessionGit;
  readonly branch: string;
  readonly baseRev: string;
}

/**
 * Builds a session's git directory from the repository's approved setup, all with host plumbing before any
 * container sees it: the config and non-sample hooks and info files are copied, objects are borrowed through
 * alternates, remote-tracking refs and tags are copied, the session branch starts at `baseRev`, and the index
 * is `read-tree HEAD` (no filters run). It is built beside its final path and renamed into place, so a crash
 * never leaves a half-made one behind.
 */
export function createSessionGitDir(options: CreateSessionGitDirOptions): void {
  const { mainRoot, commonDir, worktreePath, session, branch, baseRev } = options;
  assertMountable(session.gitDir);
  const staging = `${session.gitDir}.new-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  rmSync(session.gitDir, { recursive: true, force: true });
  mkdirSync(dirname(session.gitDir), { recursive: true });
  try {
    const format = spawnGit(["-C", mainRoot, "rev-parse", "--show-object-format"]);
    const objectFormat = format.status === 0 && format.stdout.trim() !== "" ? format.stdout.trim() : "sha1";
    const init = spawnGit(["init", "-q", "--bare", "--template=", `--object-format=${objectFormat}`, staging]);
    if (init.status !== 0) throw new AosError(`git init ${staging} failed: ${init.stderr.trim()}`);

    copyFileSync(join(commonDir, "config"), join(staging, "config"));
    gitIn(staging, ["config", "core.bare", "false"], "git config core.bare");
    for (const key of ["core.worktree", "extensions.worktreeConfig", "extensions.refStorage"]) {
      spawnGit(["--git-dir", staging, "config", "--unset-all", key]);
    }
    gitIn(staging, ["config", `remote.${HOST_REMOTE_NAME}.url`, HOST_GIT_MOUNT], "git config remote.host.url");
    gitIn(staging, ["config", `remote.${HOST_REMOTE_NAME}.fetch`, `+refs/heads/*:refs/remotes/${HOST_REMOTE_NAME}/*`], "git config remote.host.fetch");

    copyApprovedFiles(join(commonDir, "hooks"), join(staging, "hooks"));
    copyApprovedFiles(join(commonDir, "info"), join(staging, "info"));
    mkdirSync(join(staging, "objects", "info"), { recursive: true });
    writeFileSync(join(staging, "objects", "info", "alternates"), `${objectDirs(commonDir).join("\n")}\n`);

    const refs = spawnGit(["--git-dir", commonDir, "for-each-ref", "--format=create %(refname) %(objectname)", "refs/remotes", "refs/tags"]);
    if (refs.status !== 0) throw new AosError(`git for-each-ref failed in ${commonDir}: ${refs.stderr.trim()}`);
    const commands = [...refs.stdout.split("\n").filter(Boolean), `create refs/heads/${branch} ${baseRev}`].join("\n");
    const update = spawnGit(["--git-dir", staging, "update-ref", "--stdin"], { encoding: "utf8", input: `${commands}\n` });
    if (update.status !== 0) throw new AosError(`git update-ref in ${staging} failed: ${update.stderr.trim()}`);
    gitIn(staging, ["symbolic-ref", "HEAD", `refs/heads/${branch}`], "git symbolic-ref HEAD");
    gitIn(staging, ["--work-tree", worktreePath, "read-tree", "HEAD"], "git read-tree HEAD");

    renameSync(staging, session.gitDir);
    writeFileSync(session.gitFile, `gitdir: ${session.gitDir}\n`);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export interface Mount {
  readonly hostPath: string;
  readonly sandboxPath: string;
  readonly readonly?: boolean;
}

/**
 * Every container mount a worktree session needs for git: the worktree folder, the read-only `.git` file over
 * its own, the session's git directory, the repository's object stores read-only at their host paths (where
 * the alternates file names them) and the repository's whole git directory read-only for the `host` remote.
 * Nothing writable reaches the repository's git directory.
 */
export function sessionGitMounts(commonDir: string, session: SessionGit, worktreePath: string, sandboxProjectRoot: string): Mount[] {
  const stores = objectDirs(commonDir);
  for (const path of [session.gitDir, session.gitFile, commonDir, ...stores]) assertMountable(path);
  return [
    { hostPath: worktreePath, sandboxPath: sandboxProjectRoot },
    { hostPath: session.gitFile, sandboxPath: `${sandboxProjectRoot}/.git`, readonly: true },
    { hostPath: session.gitDir, sandboxPath: session.gitDir },
    ...stores.map((hostPath) => ({ hostPath, sandboxPath: hostPath, readonly: true })),
    { hostPath: commonDir, sandboxPath: HOST_GIT_MOUNT, readonly: true },
  ];
}

/**
 * An empty repository with one commit, for Sandcastle to use as its working directory. Sandcastle mounts its
 * `cwd` and that directory's `.git` read-write and runs its own host git in it, so it must never be a
 * project's checkout. One is made per launch and removed with it.
 */
export function createAnchorRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const init = spawnGit(["init", "-q", "--template=", dir]);
  if (init.status !== 0) throw new AosError(`git init ${dir} failed: ${init.stderr.trim()}`);
  const commit = spawnGit(["-C", dir, "-c", "user.name=aos", "-c", "user.email=aos@localhost", "commit", "-q", "--allow-empty", "-m", "aos anchor"]);
  if (commit.status !== 0) throw new AosError(`Could not create the anchor repository ${dir}: ${commit.stderr.trim()}`);
  return dir;
}

/** Removes a session's git directory. rmSync never follows the symlinks an agent may have left inside it. */
export function removeSessionGitDir(session: SessionGit): void {
  rmSync(session.gitDir, { recursive: true, force: true });
  rmSync(session.gitFile, { force: true });
}

/** Reads a small agent-reachable file as data: no symlink anywhere on the way, regular file, bounded size. */
function readDataFile(root: string, relative: string, maxBytes: number): string | undefined {
  const parts = relative.split("/");
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined || stat.isSymbolicLink()) return undefined;
  }
  let fd: number;
  try {
    fd = openSync(current, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return undefined;
    const buffer = Buffer.alloc(stat.size);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function assertPlainBranch(branch: string): void {
  if (branch.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new AosError(`Branch name ${branch} is not usable.`);
  }
}

/**
 * Tip of the session branch in the session's git directory, read straight from its loose ref or
 * `packed-refs` as plain data, with no git process: the directory is written by the agent.
 */
export function readSessionTip(session: SessionGit, branch: string): string | undefined {
  assertPlainBranch(branch);
  const loose = readDataFile(session.gitDir, `refs/heads/${branch}`, MAX_REF_BYTES)?.trim();
  if (loose !== undefined && OBJECT_ID.test(loose)) return loose;
  const packed = readDataFile(session.gitDir, "packed-refs", MAX_PACKED_REFS_BYTES);
  for (const line of packed?.split("\n") ?? []) {
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) (.+)$/.exec(line);
    if (match?.[2] === `refs/heads/${branch}`) return match[1];
  }
  return undefined;
}

/** The branch the session's `HEAD` is on, "" when detached or unreadable. */
export function readSessionHeadBranch(session: SessionGit): string {
  const head = readDataFile(session.gitDir, "HEAD", MAX_REF_BYTES)?.trim() ?? "";
  return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : "";
}

export type ImportOutcome =
  | { readonly kind: "unchanged"; readonly adopt?: string }
  | { readonly kind: "imported"; readonly branch: string; readonly from: string; readonly tip: string; readonly diverged: boolean };

export interface ImportOptions {
  readonly commonDir: string;
  /** The session's worktree folder, whose host index is refreshed after the branch moved; undefined leaves every folder alone. */
  readonly worktreePath: string | undefined;
  readonly session: SessionGit;
  /** The session branch in the session's git directory. */
  readonly branch: string;
  /** Tip imported last, which the repository's branch must still be at for the import to replace it. */
  readonly importedTip: string | undefined;
  /** Branch receiving imports once the session diverged from commits made on the Mac. */
  readonly importBranch: string | undefined;
  readonly scratchDir: string;
}

interface CommandResult {
  readonly status: number | null;
  readonly stderr: string;
}

function runDocker(args: readonly string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(DOCKER_CMD, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ status: null, stderr: error.message });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolvePromise({ status, stderr });
    });
  });
}

const hostGit = (commonDir: string, args: readonly string[]): Promise<GitResult> => spawnGitAsync(["--git-dir", commonDir, ...args]);

async function branchTip(commonDir: string, branch: string): Promise<string | undefined> {
  const result = await hostGit(commonDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

async function freeBranch(commonDir: string, branch: string): Promise<string> {
  for (let n = 1; n < 1000; n++) {
    if ((await branchTip(commonDir, `${branch}-${n}`)) === undefined) return `${branch}-${n}`;
  }
  throw new AosError(`Could not find a free branch name next to ${branch}.`);
}

/**
 * Brings the session branch back into the repository. A throwaway container with no network writes a git
 * bundle from the read-only session git directory, so only a container ever runs git in agent-written
 * metadata; the host fetches the bundle (a bundle is data, and fsck checks every object) and moves the branch.
 *
 * Ownership rule: the repository's branch is replaced only while it is still at the tip imported last, so a
 * rewritten session history imports correctly but commits made on the Mac are never discarded. When the Mac
 * moved the branch and the session no longer contains its commits, the session goes to `<branch>-<n>` instead.
 */
export async function importSessionBranch(options: ImportOptions): Promise<ImportOutcome> {
  const { commonDir, worktreePath, session, branch, importedTip, importBranch, scratchDir } = options;
  const target = importBranch ?? branch;
  const hostTip = await branchTip(commonDir, target);
  if (hostTip === undefined) {
    throw new AosError(`Branch ${target} no longer exists in the repository, so the session's commits were not imported.`);
  }
  const sessionTip = readSessionTip(session, branch);
  if (sessionTip === undefined || sessionTip === importedTip) return { kind: "unchanged" };
  if (sessionTip === hostTip) return { kind: "unchanged", adopt: sessionTip };

  const { uid, gid } = hostIds();
  const out = mkdtempSync(join(scratchDir, "import-"));
  const tmpRef = `refs/aos/import/${process.pid}-${Date.now()}`;
  try {
    const stores = objectDirs(commonDir);
    const mounts = [session.gitDir, ...stores].flatMap((path) => ["-v", `${path}:${path}:ro`]);
    const bundle = await runDocker(
      [
        "run", "--rm", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--user", `${uid}:${gid}`, ...mounts, "-v", `${out}:/out`, "--entrypoint", "/usr/bin/git", IMAGE,
        "-c", "safe.directory=*", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
        "--git-dir", session.gitDir, "bundle", "create", "/out/session.bundle", `refs/heads/${branch}`, `^${hostTip}`,
      ],
      BUNDLE_TIMEOUT_MS,
    );
    if (bundle.status !== 0) {
      if (/empty bundle/i.test(bundle.stderr)) return { kind: "unchanged", adopt: sessionTip };
      throw new AosError(`Could not export ${branch} from the session: ${bundle.stderr.trim()}`);
    }

    const fetch = await hostGit(commonDir, [
      "-c", "transfer.fsckObjects=true", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "fetch", "-q", "--no-tags", "--no-write-fetch-head", join(out, "session.bundle"), `+refs/heads/${branch}:${tmpRef}`,
    ]);
    if (fetch.status !== 0) throw new AosError(`Could not import ${branch}: ${fetch.stderr.trim()}`);
    const rev = await hostGit(commonDir, ["rev-parse", "--verify", tmpRef]);
    if (rev.status !== 0) throw new AosError(`Could not read the imported ${branch}: ${rev.stderr.trim()}`);
    const tip = rev.stdout.trim();

    const contains = (await hostGit(commonDir, ["merge-base", "--is-ancestor", hostTip, tip])).status === 0;
    const hostMoved = importedTip === undefined || hostTip !== importedTip;
    const diverged = !contains && hostMoved;
    const destination = diverged ? await freeBranch(commonDir, branch) : target;
    const expected = diverged ? "0".repeat(tip.length) : hostTip;
    const update = await hostGit(commonDir, ["update-ref", `refs/heads/${destination}`, tip, expected]);
    if (update.status !== 0) throw new AosError(`Could not move ${destination} to the imported commits: ${update.stderr.trim()}`);
    if (!diverged && destination === branch && worktreePath !== undefined) await spawnGitAsync(["-C", worktreePath, "reset", "-q"]);
    return { kind: "imported", branch: destination, from: hostTip, tip, diverged };
  } finally {
    await hostGit(commonDir, ["update-ref", "-d", tmpRef]);
    rmSync(out, { recursive: true, force: true });
  }
}

export function describeImport(outcome: ImportOutcome, branch: string): string | undefined {
  if (outcome.kind === "unchanged") return undefined;
  const range = `${outcome.from.slice(0, 7)}..${outcome.tip.slice(0, 7)}`;
  if (!outcome.diverged) return `imported ${branch} (${range})`;
  return `${branch} has commits made on the Mac that the session does not contain, so the session's commits went to ${outcome.branch} (${range}) and ${branch} is untouched. Merge ${outcome.branch} yourself.`;
}

export interface SyncContext {
  readonly paths: AosPaths;
  readonly key: string;
  readonly commonDir: string;
  readonly worktreePath: string | undefined;
  readonly session: SessionGit;
  readonly scratchDir: string;
}

/**
 * Imports one session's branch and records what was imported. One import per session runs at a time (the
 * live import, `aos worktree merge`, `rm` and the session end can all ask), and the record is re-read
 * under that lock so the ownership rule always sees the tip imported last.
 */
export async function syncSession(context: SyncContext): Promise<{ record: WorktreeRecord; outcome: ImportOutcome }> {
  const { paths, key, session } = context;
  return withFileLock(`${session.gitDir}.lock`, async () => {
    const record = readRegistry(paths, key).find((r) => r.id === session.id);
    if (record === undefined) throw new AosError(`No aos worktree record ${session.id}.`);
    const outcome = await importSessionBranch({
      commonDir: context.commonDir,
      worktreePath: context.worktreePath,
      session,
      branch: record.branch,
      importedTip: record.importedTip,
      importBranch: record.importBranch,
      scratchDir: context.scratchDir,
    });
    const update = (apply: (target: WorktreeRecord) => void): Promise<WorktreeRecord> =>
      withRegistryLock(paths, key, (records) => {
        const target = records.find((r) => r.id === record.id) ?? record;
        apply(target);
        return { records, value: { ...target } };
      });
    if (outcome.kind === "imported") {
      const updated = await update((target) => {
        target.importedTip = outcome.tip;
        if (outcome.diverged) target.importBranch = outcome.branch;
      });
      return { record: updated, outcome };
    }
    if (outcome.adopt !== undefined) {
      const updated = await update((target) => {
        target.importedTip = outcome.adopt;
      });
      return { record: updated, outcome };
    }
    return { record, outcome };
  });
}

export interface LiveImport {
  /** Stops watching and waits for an import still running. */
  readonly stop: () => Promise<void>;
}

/**
 * Calls `run` once about `settleMs` after `read()` stops changing, for every burst of changes. `read` is
 * called on a fixed interval, so a burst of commits is imported once, a second after the last one.
 */
export function watchForChange(options: {
  readonly read: () => string | undefined;
  readonly run: () => Promise<void>;
  readonly intervalMs?: number;
  readonly settleMs?: number;
}): LiveImport {
  const { read, run, intervalMs = 400, settleMs = 800 } = options;
  let last = read();
  let changedAt: number | undefined;
  let running: Promise<void> = Promise.resolve();
  let busy = false;
  const timer = setInterval(() => {
    const now = read();
    if (now !== last) {
      last = now;
      changedAt = Date.now();
    }
    if (changedAt === undefined || busy || Date.now() - changedAt < settleMs) return;
    changedAt = undefined;
    busy = true;
    running = run()
      .catch(() => {})
      .finally(() => {
        busy = false;
      });
  }, intervalMs);
  timer.unref();
  return {
    stop: async () => {
      clearInterval(timer);
      await running;
    },
  };
}

/** True when the directory exists as a real directory, not a symlink an agent may have planted. */
export function sessionGitDirExists(session: SessionGit): boolean {
  return lstatSync(session.gitDir, { throwIfNoEntry: false })?.isDirectory() === true;
}
