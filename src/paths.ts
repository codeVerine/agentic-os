import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AosError } from "./errors.ts";

export interface AosPaths {
  readonly root: string;
  readonly projects: string;
  readonly secrets: string;
  readonly secretsEnv: string;
  readonly sessions: string;
  /** Per-launch runtime directories, removed when the launch ends. */
  readonly run: string;
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
    sessions: join(root, "state", "sessions"),
    run: join(root, "state", "run"),
  };
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
function assertGitMetadataMountable(root: string): void {
  const dotGit = join(root, ".git");
  if (lstatSync(dotGit, { throwIfNoEntry: false })?.isFile() !== true) return;
  const superproject = git(root, "rev-parse", "--show-superproject-working-tree");
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
  const commonDir = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (basename(dirname(gitdir)) !== "worktrees" || commonDir === "" || realpathSync(mounted) !== realpathSync(commonDir)) {
    throw new AosError(
      `${root} keeps its git directory at ${gitdir}, outside the project, and is not a linked worktree, so the sandbox would have to mount ${mounted}. Run aos from a checkout whose .git is a directory, or from a linked worktree.`,
    );
  }
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

function gitRoot(dir: string): string {
  const top = git(dir, "rev-parse", "--show-toplevel");
  if (top === "") {
    throw new AosError(
      `${dir} is not inside a git repository. aos needs a git repository with at least one commit: run "git init" and make a first commit in your project, then run the command again.`,
    );
  }
  return realpathOrThrow(top, `Git repository root ${top} does not exist.`);
}

function git(dir: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function realpathOrThrow(path: string, message: string): string {
  try {
    return realpathSync(path);
  } catch {
    throw new AosError(message);
  }
}
