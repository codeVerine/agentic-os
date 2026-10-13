import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AosError } from "./errors.ts";
import { spawnGit } from "./git.ts";
import type { AosPaths } from "./paths.ts";

/**
 * The `includeIf "onbranch:aos/**"` guard: while an agent branch is checked out, host git runs
 * with aos's own core settings (no hooks, no fsmonitor), so running git or npm inside an agent
 * worktree folder on the Mac cannot run agent-written hook stubs or a planted fsmonitor daemon.
 *
 * The include line must live in the repository's own config, appended last: repo-local keys beat
 * a global include, so a global line would lose to the repository's own `core.hooksPath` (verified
 * against git 2.39: a global `includeIf` does not override repo-local keys, a trailing repo-local
 * one does). Install per project with `aos guard install` (explicit consent); the snippet itself
 * is aos-owned and rewritten by `aos init`.
 */
export const GUARD_BRANCH_PATTERN = "aos/**";
const GUARD_CONDITION = `onbranch:${GUARD_BRANCH_PATTERN}`;
const GUARD_KEY = `includeIf.${GUARD_CONDITION}.path`;

const GUARD_FILE_CONTENT = `# Owned by aos ("aos guard install"). While a branch matching "${GUARD_BRANCH_PATTERN}"
# is checked out, host git on the Mac runs with these settings instead of the
# repository's own hooks and fsmonitor. Do not edit: it is rewritten by aos.
[core]
\thooksPath = /dev/null
\tfsmonitor = false
`;

/** Path of the aos-owned gitconfig snippet the includeIf line points at. */
export function guardConfigPath(paths: AosPaths): string {
  return join(paths.root, "state", "gitconfig-aos-branches");
}

/** Writes (or refreshes) the aos-owned snippet. Safe to re-run; user content lives elsewhere. */
export function ensureGuardFile(paths: AosPaths): string {
  const path = guardConfigPath(paths);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, GUARD_FILE_CONTENT);
  return path;
}

function gitConfig(mainRoot: string, args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnGit(["-C", mainRoot, "config", "--local", ...args]);
  if (result.error) throw new AosError(`git config failed to start: ${result.error.message}`);
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

/** Effective includeIf target in this repository (last entry wins), or undefined when absent. */
export function guardIncludeTarget(mainRoot: string): string | undefined {
  const result = gitConfig(mainRoot, ["--get-all", GUARD_KEY]);
  if (result.status !== 0) return undefined;
  const values = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  return values.length > 0 ? values[values.length - 1] : undefined;
}

/** Number of includeIf entries in this repository (install keeps exactly one). */
export function guardIncludeCount(mainRoot: string): number {
  const result = gitConfig(mainRoot, ["--get-all", GUARD_KEY]);
  if (result.status !== 0) return 0;
  return result.stdout.split("\n").filter((line) => line.trim()).length;
}

export type GuardStatus =
  | { readonly state: "ok"; readonly path: string }
  | { readonly state: "missing" }
  | { readonly state: "points-elsewhere"; readonly path: string }
  | { readonly state: "shadowed"; readonly path: string; readonly key: string };

/** Whether this repository's includeIf line exists and points at this root's snippet. */
export function guardStatus(paths: AosPaths, mainRoot: string): GuardStatus {
  const target = guardIncludeTarget(mainRoot);
  if (target === undefined) return { state: "missing" };
  if (target !== guardConfigPath(paths)) return { state: "points-elsewhere", path: target };
  const shadow = guardShadowKey(mainRoot);
  if (shadow) return { state: "shadowed", path: target, key: shadow };
  return { state: "ok", path: target };
}

/**
 * A repo-local key written after the include line that re-enables what the guard pauses.
 * `git config` appends brand-new keys at the end of the file, so a later install of a hook
 * runner on the Mac can quietly unseat the guard; status reports it instead of a false ok.
 */
function guardShadowKey(mainRoot: string): string | undefined {
  const listed = gitConfig(mainRoot, ["--list"]);
  if (listed.status !== 0) return undefined;
  const keys = listed.stdout
    .split("\n")
    .map((line) => line.slice(0, line.indexOf("=")).trim().toLowerCase())
    .filter(Boolean);
  const guardAt = keys.lastIndexOf(GUARD_KEY.toLowerCase());
  if (guardAt === -1) return undefined;
  return keys
    .slice(guardAt + 1)
    .map((key) => (key === "core.hookspath" || key === "core.fsmonitor" ? key : undefined))
    .find(Boolean);
}

/**
 * Installs the includeIf line at the end of this repository's config (unset-all then add, so a
 * re-run keeps exactly one entry and it stays last, where it overrides the repository's own keys).
 * Explicit user consent is the command itself. Pass the main checkout, not a linked worktree.
 */
export function installGuard(paths: AosPaths, mainRoot: string): string {
  const snippet = ensureGuardFile(paths);
  gitConfig(mainRoot, ["--unset-all", GUARD_KEY]);
  const added = gitConfig(mainRoot, ["--add", GUARD_KEY, snippet]);
  if (added.status !== 0) throw new AosError(`git config --local --add failed in ${mainRoot}: ${added.stderr || "unknown error"}`);
  return snippet;
}

/** Removes the includeIf line from this repository; leaves the snippet in place. Missing counts as removed. */
export function removeGuard(mainRoot: string): void {
  gitConfig(mainRoot, ["--unset-all", GUARD_KEY]);
}

/** True when the snippet file exists and holds exactly the content aos manages. */
export function guardFileIntact(paths: AosPaths): boolean {
  const path = guardConfigPath(paths);
  try {
    return existsSync(path) && readFileSync(path, "utf8") === GUARD_FILE_CONTENT;
  } catch {
    return false;
  }
}
