import { execFileSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";

export const fileMode = (path: string): number => statSync(path).mode & 0o777;

/** Creates `dir` (and its parents) as an empty git repository and returns it. */
export function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "--quiet", dir]);
  return dir;
}

/** Makes one empty commit in `dir` with a fixed identity, so it does not depend on the machine's git config. */
export function commitEmpty(dir: string): void {
  execFileSync("git", ["-C", dir, "config", "user.email", "aos@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "aos"]);
  execFileSync("git", ["-C", dir, "commit", "--quiet", "--allow-empty", "-m", "init"]);
}

/** Creates `dir` as a git repository holding one empty commit and returns it. */
export function initCommittedRepo(dir: string): string {
  initRepo(dir);
  commitEmpty(dir);
  return dir;
}
