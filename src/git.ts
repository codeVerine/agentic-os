import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import { hookSafeGitEnv } from "./hostenv.ts";

/**
 * Runs `git` on the host with the same hook and fsmonitor protection aos gives Sandcastle's own
 * git calls (see `hookSafeGitEnv`), so every host-side git call aos makes shares it, no matter the
 * caller's own `env` or the ambient process env it runs under.
 */
export function spawnGit(
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding = { encoding: "utf8" },
): SpawnSyncReturns<string> {
  return spawnSync("git", args, { ...options, env: { ...process.env, ...options.env, ...hookSafeGitEnv() } });
}
