import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { AosError } from "../src/errors.ts";
import { aosRoot, locateProject, sandboxName } from "../src/paths.ts";

describe("aosRoot", () => {
  test("defaults to ~/AgenticOS", () => {
    assert.equal(aosRoot({}), join(homedir(), "AgenticOS"));
  });

  test("uses AOS_ROOT, expanding ~ and resolving relative paths", () => {
    assert.equal(aosRoot({ AOS_ROOT: "/srv/aos" }), "/srv/aos");
    assert.equal(aosRoot({ AOS_ROOT: "~/lab" }), join(homedir(), "lab"));
    assert.equal(aosRoot({ AOS_ROOT: "rel/aos" }), join(process.cwd(), "rel/aos"));
  });

  test("ignores a blank AOS_ROOT", () => {
    assert.equal(aosRoot({ AOS_ROOT: "  " }), join(homedir(), "AgenticOS"));
  });
});

describe("locateProject", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "aos-paths-")));
  after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, "home");

  function repo(...parts: string[]): string {
    const dir = join(home, ...parts);
    mkdirSync(join(dir, "src", "lib"), { recursive: true });
    execFileSync("git", ["init", "--quiet", dir]);
    return dir;
  }

  test("launches from an arbitrary git directory outside AOS_ROOT", () => {
    const dir = repo("Projects", "pi-auto-btw");
    const project = locateProject(dir);
    assert.equal(project.name, "pi-auto-btw");
    assert.equal(project.root, dir);
    assert.equal(project.subdir, "");
    assert.match(project.sandboxName, /^pi-auto-btw-[0-9a-f]{8}$/);
  });

  test("resolves a subdirectory to the repository root and keeps the subdirectory", () => {
    const dir = repo("Projects", "demo");
    const project = locateProject(join(dir, "src", "lib"));
    assert.equal(project.root, dir);
    assert.equal(project.subdir, "src/lib");
  });

  test("resolves symlinked working directories", () => {
    const dir = repo("Projects", "linked");
    const link = join(base, "link-to-linked");
    symlinkSync(dir, link);
    assert.equal(locateProject(link).root, dir);
  });

  test("refuses a directory that is not in a git repository, asking for a repository with a commit", () => {
    const dir = join(base, "plain");
    mkdirSync(dir);
    assert.throws(() => locateProject(dir), /git repository with at least one commit/);
  });

  test("gives folders with the same basename different container names", () => {
    const a = locateProject(repo("a", "app"));
    const b = locateProject(repo("b", "app"));
    assert.equal(a.name, b.name);
    assert.notEqual(a.sandboxName, b.sandboxName);
    assert.equal(locateProject(a.root).sandboxName, a.sandboxName);
  });

  test("sanitises basenames Docker or the agents cannot use", () => {
    assert.match(sandboxName(".hidden dir", "/x/.hidden dir"), /^hidden-dir-[0-9a-f]{8}$/);
    assert.match(sandboxName("...", "/x/..."), /^project-[0-9a-f]{8}$/);
  });

  function committedRepo(...parts: string[]): string {
    const dir = repo(...parts);
    execFileSync("git", ["-C", dir, "commit", "--allow-empty", "--quiet", "-m", "init"]);
    return dir;
  }

  test("resolves a linked worktree with an absolute gitdir to the worktree root and keeps the subdirectory", () => {
    const main = committedRepo("Projects", "with-worktree");
    const worktree = join(home, "Projects", "with-worktree-feat");
    execFileSync("git", ["-C", main, "worktree", "add", "--quiet", worktree]);
    mkdirSync(join(worktree, "src", "lib"), { recursive: true });
    const project = locateProject(join(worktree, "src", "lib"));
    assert.equal(project.root, realpathSync(worktree));
    assert.equal(project.subdir, "src/lib");
    assert.equal(project.name, "with-worktree-feat");
  });

  test("refuses a linked worktree whose .git file uses a relative gitdir", () => {
    const main = committedRepo("Projects", "with-relative-worktree");
    const worktree = join(home, "Projects", "with-relative-worktree-feat");
    execFileSync("git", ["-C", main, "worktree", "add", "--quiet", worktree]);
    writeFileSync(join(worktree, ".git"), "gitdir: ../with-relative-worktree/.git/worktrees/with-relative-worktree-feat\n");
    assert.throws(
      () => locateProject(worktree),
      (error) => error instanceof AosError && /linked git worktree .* relative gitdir/.test(error.message),
    );
  });

  test("refuses a submodule, pointing at the superproject", () => {
    const sub = committedRepo("Projects", "sub-standalone");
    const super_ = committedRepo("Projects", "super");
    execFileSync("git", ["-C", super_, "-c", "protocol.file.allow=always", "submodule", "--quiet", "add", sub, "sub"]);
    mkdirSync(join(super_, "sub", "src"));
    for (const dir of [join(super_, "sub"), join(super_, "sub", "src")]) {
      assert.throws(
        () => locateProject(dir),
        (error) => error instanceof AosError && error.message.includes("git submodule") && error.message.includes(super_),
      );
    }
  });
});
