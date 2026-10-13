import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { aosPaths } from "../src/paths.ts";
import {
  ensureGuardFile,
  guardConfigPath,
  guardFileIntact,
  guardIncludeCount,
  guardIncludeTarget,
  guardStatus,
  installGuard,
  removeGuard,
} from "../src/guard.ts";
import { initCommittedRepo } from "./helpers.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "aos-guard-")));
after(() => rmSync(base, { recursive: true, force: true }));

const hooksPath = (repo: string): string | undefined => {
  try {
    return execFileSync("git", ["-C", repo, "config", "core.hooksPath"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
};

describe("branch guard", () => {
  test("missing until installed, ok after install, missing after remove", () => {
    const repo = initCommittedRepo(join(base, "lifecycle"));
    const paths = aosPaths(join(base, "lifecycle-root"));
    assert.equal(guardStatus(paths, repo).state, "missing");
    const snippet = installGuard(paths, repo);
    assert.equal(snippet, guardConfigPath(paths));
    assert.equal(guardFileIntact(paths), true);
    assert.equal(guardStatus(paths, repo).state, "ok");
    assert.equal(guardIncludeTarget(repo), snippet);
    removeGuard(repo);
    assert.equal(guardStatus(paths, repo).state, "missing");
  });

  test("overrides the repository's own hooksPath on aos branches, leaves other branches alone", () => {
    const repo = initCommittedRepo(join(base, "override"));
    const main = execFileSync("git", ["-C", repo, "branch", "--show-current"], { encoding: "utf8" }).trim();
    execFileSync("git", ["-C", repo, "config", "core.hooksPath", ".husky"]);
    const paths = aosPaths(join(base, "override-root"));
    installGuard(paths, repo);
    execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "aos/claude/x"]);
    assert.equal(hooksPath(repo), "/dev/null");
    execFileSync("git", ["-C", repo, "checkout", "-q", main]);
    assert.equal(hooksPath(repo), ".husky");
  });

  test("re-install keeps exactly one entry, still last", () => {    const repo = initCommittedRepo(join(base, "idempotent"));
    execFileSync("git", ["-C", repo, "config", "core.hooksPath", ".husky"]);
    const paths = aosPaths(join(base, "idempotent-root"));
    installGuard(paths, repo);
    installGuard(paths, repo);
    assert.equal(guardIncludeCount(repo), 1);
    execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "aos/pi/y"]);
    assert.equal(hooksPath(repo), "/dev/null");
  });

  test("another root sees the line as pointing elsewhere, and install repoints it", () => {
    const repo = initCommittedRepo(join(base, "repoint"));
    const first = aosPaths(join(base, "root-a"));
    const second = aosPaths(join(base, "root-b"));
    installGuard(first, repo);
    assert.equal(guardStatus(second, repo).state, "points-elsewhere");
    installGuard(second, repo);
    assert.equal(guardStatus(second, repo).state, "ok");
    assert.equal(guardStatus(first, repo).state, "points-elsewhere");
  });

  test("a trailing repo-local key unseats the guard, and re-install restores it", () => {
    const repo = initCommittedRepo(join(base, "shadowed"));
    const paths = aosPaths(join(base, "shadowed-root"));
    installGuard(paths, repo);
    assert.equal(guardStatus(paths, repo).state, "ok");
    // Plain `git config` writes land inside the existing [core] section, before the
    // include, so the guard holds. Only a key appended after it (hand edit, wholesale
    // rewrite) unseats it — simulate that by appending a second [core] section.
    writeFileSync(join(repo, ".git", "config"), "\n[core]\n\tfsmonitor = true\n", { flag: "a" });
    const shadowed = guardStatus(paths, repo);
    assert.equal(shadowed.state, "shadowed");
    execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "aos/shadow/t"]);
    assert.notEqual(execFileSync("git", ["-C", repo, "config", "core.fsmonitor"], { encoding: "utf8" }).trim(), "false");
    installGuard(paths, repo);
    assert.equal(guardStatus(paths, repo).state, "ok");
  });

  test("ensureGuardFile refreshes a hand-edited snippet", () => {
    const paths = aosPaths(join(base, "root-c"));
    const snippet = ensureGuardFile(paths);
    assert.equal(guardFileIntact(paths), true);
    writeFileSync(snippet, "[core]\n\thooksPath = /tmp/evil\n");
    assert.equal(guardFileIntact(paths), false);
    ensureGuardFile(paths);
    assert.equal(guardFileIntact(paths), true);
  });
});
