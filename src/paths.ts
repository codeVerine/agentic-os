import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
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
  /** Real path of AOS_ROOT/projects/<name> on the host. */
  readonly root: string;
  /** Path of the working directory relative to the project root, POSIX separators, "" at the root. */
  readonly subdir: string;
}

const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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

export function locateProject(cwd: string, projectsDir: string): ProjectLocation {
  const projects = realpathOrThrow(
    projectsDir,
    `Projects directory ${projectsDir} does not exist. Run "aos init" first.`,
  );
  const here = realpathOrThrow(cwd, `Current directory ${cwd} does not exist.`);
  const rel = relative(projects, here);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new AosError(
      `${here} is not inside a project. cd into ${join(projects, "<project>")} and run the command again.`,
    );
  }
  const [name = "", ...rest] = rel.split(sep);
  if (!PROJECT_NAME.test(name)) {
    throw new AosError(
      `Project name "${name}" is not supported. Use letters, digits, ".", "_" and "-", starting with a letter or digit.`,
    );
  }
  const root = join(projects, name);
  if (root.includes(":") || root.includes(",")) {
    throw new AosError(`Project path ${root} contains ":" or ",", which Docker bind mounts cannot express.`);
  }
  return { name, root, subdir: rest.join("/") };
}

function realpathOrThrow(path: string, message: string): string {
  try {
    return realpathSync(path);
  } catch {
    throw new AosError(message);
  }
}
