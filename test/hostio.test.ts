import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { promisify } from "node:util";
import { applyDefaults } from "../src/defaults.ts";
import { readTextFileInside, writePrivateFileAtomic } from "../src/fsutil.ts";
import { assertGitMetadataMountable, assertProjectEnvNotLinked } from "../src/paths.ts";
import { initCommittedRepo } from "./helpers.ts";

const run = promisify(execFile);
const base = realpathSync(mkdtempSync(join(tmpdir(), "aos-hostio-")));
after(() => rmSync(base, { recursive: true, force: true }));

function scratch(name: string): string {
  const dir = join(base, name);
  mkdirSync(dir);
  return dir;
}

describe("symlinked .git", () => {
  test("is refused, since the mounts would follow it to a directory the project does not own", () => {
    const dir = scratch("git-link");
    const elsewhere = scratch("git-link-target");
    writeFileSync(join(elsewhere, "gitdir-file"), `gitdir: ${elsewhere}/x\n`);
    symlinkSync(join(elsewhere, "gitdir-file"), join(dir, ".git"));
    assert.throws(() => assertGitMetadataMountable(dir), /\.git is a symlink/);
  });
});

describe("writePrivateFileAtomic", () => {
  test("never writes through a symlink planted at a predictable staging name", () => {
    const dir = scratch("staging");
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "precious");
    const target = join(dir, "settings.json");
    symlinkSync(victim, `${target}.aos-${process.pid}.tmp`);
    writePrivateFileAtomic(target, "{}");
    assert.equal(readFileSync(victim, "utf8"), "precious");
    assert.equal(readFileSync(target, "utf8"), "{}");
  });

  test("removes its staging file when the rename fails", () => {
    const dir = scratch("staging-fail");
    mkdirSync(join(dir, "occupied"));
    writeFileSync(join(dir, "occupied", "child"), "");
    assert.throws(() => writePrivateFileAtomic(join(dir, "occupied"), "x"));
    assert.deepEqual(readdirSync(dir), ["occupied"]);
  });
});

describe("host reads", () => {
  test("applyDefaults refuses a settings file that is a symlink, so host-only values never reach the container", () => {
    const agentDir = scratch("agent");
    const hostOnly = join(base, "host-only.json");
    writeFileSync(hostOnly, JSON.stringify({ apiKey: "sk-host" }));
    symlinkSync(hostOnly, join(agentDir, "settings.json"));
    assert.throws(() => applyDefaults(agentDir, { file: "settings.json", values: { a: 1 } }), /is a symlink/);
    assert.deepEqual(JSON.parse(readFileSync(hostOnly, "utf8")), { apiKey: "sk-host" });
  });

  test("a parent directory that resolves outside the root is refused", () => {
    const root = scratch("root");
    const outside = scratch("outside");
    writeFileSync(join(outside, "settings.json"), "{}");
    symlinkSync(outside, join(root, "config"));
    assert.throws(() => readTextFileInside(root, join(root, "config", "settings.json")), /resolves outside/);
  });

  test("a missing file reads as absent, and a regular file reads as its text", () => {
    const root = scratch("plain");
    assert.equal(readTextFileInside(root, join(root, "a.json")), undefined);
    assert.equal(readTextFileInside(root, join(root, "no-dir", "a.json")), undefined);
    writeFileSync(join(root, "a.json"), "{}");
    assert.equal(readTextFileInside(root, join(root, "a.json")), "{}");
  });

  test("the project's .sandcastle/.env may not be a symlink", () => {
    const project = initCommittedRepo(scratch("project"));
    mkdirSync(join(project, ".sandcastle"));
    assertProjectEnvNotLinked(project);
    writeFileSync(join(project, ".sandcastle", ".env"), "A=1\n");
    assertProjectEnvNotLinked(project);
    rmSync(join(project, ".sandcastle", ".env"));
    symlinkSync(join(base, "host-only.json"), join(project, ".sandcastle", ".env"));
    assert.throws(() => assertProjectEnvNotLinked(project), /is a symlink/);
  });
});

describe("trustCodexProject", () => {
  test("parallel aos processes keep every project's trust entry", async () => {
    const home = scratch("codex-home");
    const script = join(import.meta.dirname, "..", "src", "trust.ts");
    const code = `const { trustCodexProject } = await import(${JSON.stringify(script)});
      for (let i = 0; i < 25; i++) await trustCodexProject(${JSON.stringify(home)}, "/p/" + process.argv[1] + "-" + i);`;
    await Promise.all(["a", "b", "c", "d"].map((tag) => run(process.execPath, ["--input-type=module", "-e", code, tag])));
    const config = readFileSync(join(home, "config.toml"), "utf8");
    assert.equal(config.match(/^\[projects\./gm)?.length, 100);
    assert.equal(existsSync(join(home, "config.toml.lock")), false);
  });
});
