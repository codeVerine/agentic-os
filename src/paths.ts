import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AosError } from "./errors.ts";
import { readTextFileInside } from "./fsutil.ts";
import { gitOrEmpty } from "./git.ts";

export interface AosPaths {
  readonly root: string;
  readonly projects: string;
  readonly secrets: string;
  readonly secretsEnv: string;
  /** One cached GitHub installation token per repository, shared by concurrent aos sessions. */
  readonly githubTokens: string;
  /** Per-launch runtime directories, removed when the launch ends. */
  readonly run: string;
  /** One JSON registry file per project (by git-common-dir hash) of aos-leased worktrees. */
  readonly worktrees: string;
  /** Private git directories of aos worktree sessions, one folder per project. Never mounted whole. */
  readonly gitdirs: string;
  /** The treehouse pool root for aos worktrees, kept apart from the user's own pool. */
  readonly treehouse: string;
  /** One pre-commit cache folder per project, mounted into containers only. */
  readonly preCommitCache: string;
  /** One file per project that pins the GitHub repository aos may mint tokens for. */
  readonly githubRepos: string;
  /** User-owned binaries aos manages itself (vendored treehouse), resolved by absolute path. */
  readonly bin: string;
}

export interface ProjectLocation {
  readonly name: string;
  /** Directory name inside the container: basename plus a short hash of the host path. */
  readonly sandboxName: string;
  /** Real path of the project's git repository root on the host. */
  readonly root: string;
  /** Path of the working directory relative to the project root, POSIX separators, "" at the root. */
  readonly subdir: string;
}

export function aosRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.AOS_ROOT?.trim();
  if (!configured) return join(homedir(), "AgenticOS");
  if (configured === "~" || configured.startsWith("~/")) {
    return join(homedir(), configured.slice(1));
  }
  return resolve(configured);
}

export function aosPaths(root: string): AosPaths {
  const secrets = join(root, "secrets");
  return {
    root,
    projects: join(root, "projects"),
    secrets,
    secretsEnv: join(secrets, "env"),
    githubTokens: join(secrets, "github-tokens"),
    run: join(root, "state", "run"),
    worktrees: join(root, "state", "worktrees"),
    gitdirs: join(root, "state", "gitdirs"),
    treehouse: join(root, "state", "treehouse"),
    preCommitCache: join(root, "state", "pre-commit"),
    githubRepos: join(root, "state", "github-repos"),
    bin: join(root, "bin"),
  };
}

/** Refuses to run before `aos init` has created the secrets directory. */
export function assertInitialised(paths: AosPaths): void {
  if (!existsSync(paths.secrets)) throw new AosError(`${paths.secrets} does not exist. Run "aos init" first.`);
}

export function locateProject(cwd: string): ProjectLocation {
  const here = realpathOrThrow(cwd, `Current directory ${cwd} does not exist.`);
  const root = gitRoot(here);
  if (root.includes(":") || root.includes(",")) {
    throw new AosError(`Project path ${root} contains ":" or ",", which Docker bind mounts cannot express.`);
  }
  assertGitMetadataMountable(root);
  const name = basename(root);
  return {
    name,
    sandboxName: sandboxName(name, root),
    root,
    subdir: relative(root, here).split(sep).join("/"),
  };
}

/**
 * Sandcastle mounts `root/.git` and, when that is a gitdir file, the directory two levels above the gitdir it
 * names, both at their host paths. For a linked worktree with an absolute gitdir that second mount is exactly the
 * main repository's git directory; for any other gitdir file (such as `--separate-git-dir`) it can be an arbitrary
 * ancestor like the home directory, so only linked worktrees are accepted.
 * A relative gitdir resolves against the container path of `root` instead, and a submodule's `core.worktree`
 * points git back at the host path of `root`, so git fails inside the container for both.
 */
export function assertGitMetadataMountable(root: string): void {
  const dotGit = join(root, ".git");
  const entry = lstatSync(dotGit, { throwIfNoEntry: false });
  if (entry?.isSymbolicLink()) {
    throw new AosError(`${dotGit} is a symlink, and the sandbox would mount whatever it points at. Replace it with the real .git directory or file.`);
  }
  if (entry?.isFile() !== true) return;
  const superproject = gitOrEmpty(root, "rev-parse", "--show-superproject-working-tree");
  if (superproject !== "") {
    throw new AosError(
      `${root} is a git submodule, and git cannot reach its repository from inside the container. Run aos from the superproject ${superproject} instead.`,
    );
  }
  const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim() ?? "";
  if (!isAbsolute(gitdir)) {
    throw new AosError(
      `${root} has a .git file with a relative gitdir path, which does not resolve inside the container. Run aos from the main checkout, or run "git worktree repair" with worktree.useRelativePaths unset.`,
    );
  }
  if (gitdir.includes(":") || gitdir.includes(",")) {
    throw new AosError(`Git directory ${gitdir} contains ":" or ",", which Docker bind mounts cannot express.`);
  }
  const mounted = resolve(gitdir, "..", "..");
  const commonDir = gitOrEmpty(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (basename(dirname(gitdir)) !== "worktrees" || commonDir === "" || realpathSync(mounted) !== realpathSync(commonDir)) {
    throw new AosError(
      `${root} keeps its git directory at ${gitdir}, outside the project, and is not a linked worktree, so the sandbox would have to mount ${mounted}. Run aos from a checkout whose .git is a directory, or from a linked worktree.`,
    );
  }
}

/**
 * Sandcastle copies the values in `<root>/.sandcastle/.env` into the container, and reads that file on the host
 * through any symlink. A symlink planted in the project would send a host-only file's values to the agent.
 */
export function assertProjectEnvNotLinked(root: string): void {
  readTextFileInside(root, join(root, ".sandcastle", ".env"));
}

/**
 * Host path of the shared git directory Sandcastle mounts at that same path for a linked worktree, or
 * undefined when `root/.git` is a directory (a main checkout keeps its git directory inside the project mount).
 */
export function sharedGitDirMount(root: string): string | undefined {
  const dotGit = join(root, ".git");
  if (lstatSync(dotGit, { throwIfNoEntry: false })?.isFile() !== true) return undefined;
  const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
  return gitdir === undefined ? undefined : resolve(gitdir, "..", "..");
}

/**
 * Container directory name for a project: its sanitised basename plus a short hash of the real host path,
 * so ~/a/app and ~/b/app get different container paths and never share agent history or trust entries.
 */
export function sandboxName(name: string, root: string): string {
  const slug = name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "project";
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
}

/**
 * Real path of the repository's shared git directory, the same for the main checkout and every
 * linked worktree. A stable identity for "this repository" independent of which worktree aos runs
 * from, used to key the aos worktree registry and the container path of a leased worktree.
 */
export function gitCommonDir(root: string): string {
  const common = gitOrEmpty(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (common === "") throw new AosError(`Could not resolve the git directory for ${root}.`);
  return realpathOrThrow(common, `Git directory ${common} does not exist.`);
}

function gitRoot(dir: string): string {
  const top = gitOrEmpty(dir, "rev-parse", "--show-toplevel");
  if (top === "") {
    throw new AosError(
      `${dir} is not inside a git repository. aos needs a git repository with at least one commit: run "git init" and make a first commit in your project, then run the command again.`,
    );
  }
  return realpathOrThrow(top, `Git repository root ${top} does not exist.`);
}

function realpathOrThrow(path: string, message: string): string {
  try {
    return realpathSync(path);
  } catch {
    throw new AosError(message);
  }
}
