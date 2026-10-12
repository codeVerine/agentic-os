import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { spawnGit } from "../src/git.ts";
import { hookSafeGitEnv } from "../src/hostenv.ts";

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
