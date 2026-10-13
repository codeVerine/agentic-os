import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { hookSafeGitEnv, safeDirectoryEnv, spawnGit } from "../src/git.ts";
import { initRepo } from "./helpers.ts";

describe("hookSafeGitEnv", () => {
  test("disables hooks and fsmonitor via GIT_CONFIG_* env vars", () => {
    assert.deepEqual(hookSafeGitEnv(), {
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/dev/null",
      GIT_CONFIG_KEY_1: "core.fsmonitor",
      GIT_CONFIG_VALUE_1: "false",
    });
  });
});

describe("safeDirectoryEnv", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "aos-safedir-")));
  after(() => rmSync(base, { recursive: true, force: true }));

  const otherOwner = { GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" };
  const status = (dir: string, env: Record<string, string>) =>
    spawnSync("git", ["-C", dir, "status"], { encoding: "utf8", env: { ...process.env, ...otherOwner, ...env } });

  test("lists each path as one exact safe.directory entry", () => {
    assert.deepEqual(safeDirectoryEnv(["/home/agent/projects/app-1a2b3c4d", "/Users/me/app/.git"]), {
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "/home/agent/projects/app-1a2b3c4d",
      GIT_CONFIG_KEY_1: "safe.directory",
      GIT_CONFIG_VALUE_1: "/Users/me/app/.git",
    });
  });

  test("lets git use a repository owned by someone else, and only the listed one", () => {
    const trusted = initRepo(join(base, "trusted"));
    const other = initRepo(join(base, "other"));

    assert.match(status(trusted, {}).stderr, /dubious ownership/);
    assert.equal(status(trusted, safeDirectoryEnv([trusted])).status, 0);
    assert.match(status(other, safeDirectoryEnv([trusted])).stderr, /dubious ownership/);
  });
});

describe("spawnGit", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "aos-spawngit-")));
  after(() => rmSync(base, { recursive: true, force: true }));

  test("always carries the hook-safe config, even when the caller's own env tries to clear it", () => {
    const result = spawnGit(["config", "--get", "core.hooksPath"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", GIT_CONFIG_COUNT: "0" },
    });
    assert.equal(result.stdout.trim(), "/dev/null");
  });

  test("still merges the caller's own env for everything else", () => {
    const dir = join(base, "env-merge");
    mkdirSync(dir);
    const result = spawnGit(["-C", dir, "init", "--quiet"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
    assert.equal(result.status, 0);
  });

  test("a pre-commit hook planted in the repository never runs", () => {
    const dir = join(base, "hook-repo");
    mkdirSync(dir);
    spawnGit(["-C", dir, "init", "--quiet"]);
    spawnGit(["-C", dir, "config", "user.email", "aos@example.com"]);
    spawnGit(["-C", dir, "config", "user.name", "aos"]);

    const marker = join(dir, "hook-ran");
    const hookPath = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hookPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    chmodSync(hookPath, 0o755);

    const result = spawnGit(["-C", dir, "commit", "--quiet", "--allow-empty", "-m", "test"]);
    assert.equal(result.status, 0);
    assert.equal(existsSync(marker), false);
  });
});
