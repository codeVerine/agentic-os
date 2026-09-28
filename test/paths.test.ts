import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
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
});
