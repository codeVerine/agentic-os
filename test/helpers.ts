import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

/**
 * Writes a docker stand-in into `dir`. A `docker run ... aos-dev:local <git args>` runs those git args on the
 * host (the mounts are host paths already), with the `/out` mount mapped to its host directory, and every call
 * is logged as one JSON array per line. Point `AOS_DOCKER_CMD` at it before `src/sessiongit.ts` loads.
 */
export function writeFakeDocker(dir: string): { cmd: string; log: string } {
  const cmd = join(dir, "fake-docker");
  const log = join(dir, "docker.log");
  writeFileSync(
    cmd,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const image = args.indexOf("aos-dev:local");
if (args[0] !== "run" || image < 0) process.exit(0);
const outMount = args.find((a) => a.endsWith(":/out"));
const out = outMount ? outMount.slice(0, -":/out".length) : "";
const gitArgs = args.slice(image + 1).map((a) => (out && a.startsWith("/out/") ? out + a.slice(4) : a));
const result = spawnSync("git", gitArgs, { stdio: ["ignore", "inherit", "inherit"] });
process.exit(result.status ?? 1);
`,
  );
  chmodSync(cmd, 0o755);
  return { cmd, log };
}
