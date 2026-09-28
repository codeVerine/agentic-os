import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { AosError } from "../src/errors.ts";
import { aosPaths, aosRoot, locateProject } from "../src/paths.ts";

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
  const root = mkdtempSync(join(tmpdir(), "aos-paths-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const paths = aosPaths(root);
  mkdirSync(join(paths.projects, "demo", "src", "lib"), { recursive: true });
  mkdirSync(join(paths.projects, ".hidden"), { recursive: true });
  mkdirSync(join(root, "elsewhere"), { recursive: true });

  test("finds the project from its root", () => {
    const project = locateProject(join(paths.projects, "demo"), paths.projects);
    assert.equal(project.name, "demo");
    assert.equal(project.subdir, "");
    assert.match(project.root, /projects\/demo$/);
  });

  test("keeps the subdirectory the command ran from", () => {
    const project = locateProject(join(paths.projects, "demo", "src", "lib"), paths.projects);
    assert.equal(project.name, "demo");
    assert.equal(project.subdir, "src/lib");
  });

  test("resolves symlinked working directories", () => {
    const link = join(root, "link-to-demo");
    symlinkSync(join(paths.projects, "demo"), link);
    assert.equal(locateProject(link, paths.projects).name, "demo");
  });

  test("refuses the projects directory itself", () => {
    assert.throws(() => locateProject(paths.projects, paths.projects), AosError);
  });

  test("refuses directories outside the projects directory", () => {
    assert.throws(() => locateProject(join(root, "elsewhere"), paths.projects), /is not inside a project/);
    assert.throws(() => locateProject(root, paths.projects), /is not inside a project/);
  });

  test("refuses project names Docker mounts or containers cannot use", () => {
    assert.throws(() => locateProject(join(paths.projects, ".hidden"), paths.projects), /not supported/);
  });

  test("asks for aos init when the projects directory is missing", () => {
    const missing = aosPaths(join(root, "missing"));
    assert.throws(() => locateProject(root, missing.projects), /aos init/);
  });
});
