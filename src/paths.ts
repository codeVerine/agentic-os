import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AosError } from "./errors.ts";

export interface AosPaths {
  readonly root: string;
  readonly projects: string;
  readonly secrets: string;
  readonly secretsEnv: string;
  readonly sessions: string;
  /** One approved project root per line. Lives outside every project and is never mounted into a container. */
  readonly approvedFolders: string;
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
    approvedFolders: join(root, "state", "approved-folders"),
    run: join(root, "state", "run"),
  };
}

export function locateProject(cwd: string): ProjectLocation {
  const here = realpathOrThrow(cwd, `Current directory ${cwd} does not exist.`);
  const root = gitRoot(here);
  if (root.includes(":") || root.includes(",")) {
    throw new AosError(`Project path ${root} contains ":" or ",", which Docker bind mounts cannot express.`);
  }
  const name = basename(root);
  return { name, sandboxName: sandboxName(name, root), root, subdir: relative(root, here).split(sep).join("/") };
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
  const result = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  const top = result.status === 0 ? result.stdout.trim() : "";
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
