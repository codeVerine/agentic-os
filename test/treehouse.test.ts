import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
  binaryMatchesVersion,
  compareTreehouseVersions,
  normalizeTreehouseVersion,
  parseTreehouseInstallArgs,
  installTreehouse,
  isSupportedTreehouseVersion,
  resolveTreehouseCmd,
  TREEHOUSE_MIN_VERSION,
  TREEHOUSE_PINNED_VERSION,
  treehouseAssetName,
  treehouseDownloadUrl,
  vendoredTreehousePath,
} from "../src/treehouse.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "aos-treehouse-")));
after(() => rmSync(base, { recursive: true, force: true }));

describe("treehouse release mapping", () => {
  test("asset names mirror install.sh (os-arch tarballs)", () => {
    assert.equal(treehouseAssetName("v2.3.0", "darwin", "arm64"), "treehouse-v2.3.0-darwin-arm64.tar.gz");
    assert.equal(treehouseAssetName("v2.3.0", "linux", "x64"), "treehouse-v2.3.0-linux-amd64.tar.gz");
    assert.equal(treehouseAssetName("2.3.0", "linux", "amd64"), "treehouse-v2.3.0-linux-amd64.tar.gz");
  });

  test("download URLs point at the pinned GitHub release", () => {
    assert.equal(
      treehouseDownloadUrl("v2.3.0", "darwin", "arm64"),
      "https://github.com/kunchenguid/treehouse/releases/download/v2.3.0/treehouse-v2.3.0-darwin-arm64.tar.gz",
    );
  });

  test("unsupported hosts fail with the supported set", () => {
    assert.throws(() => treehouseAssetName("v2.3.0", "win32", "x64"), /darwin\/linux/);
  });

  test("version comparison orders releases", () => {
    assert.ok(compareTreehouseVersions("v2.3.0", "v2.0.0") > 0);
    assert.equal(compareTreehouseVersions("v2.3.0", "v2.3.0"), 0);
    assert.ok(compareTreehouseVersions("v1.9.9", TREEHOUSE_MIN_VERSION) < 0);
  });

  test("binary version matching accepts the requested release only", () => {
    assert.equal(binaryMatchesVersion("treehouse v2.3.0", "v2.3.0"), true);
    assert.equal(binaryMatchesVersion("treehouse v2.3.0", "v2.4.0"), false);
    assert.equal(binaryMatchesVersion("treehouse v12.3.0", "v2.3.0"), false);
    assert.equal(binaryMatchesVersion("", "v2.3.0"), false);
    assert.equal(binaryMatchesVersion(undefined, "v2.3.0"), false);
  });

  test("version whitelist accepts releases and rejects paths and flags", () => {
    assert.equal(normalizeTreehouseVersion("v2.3.0"), "v2.3.0");
    assert.equal(normalizeTreehouseVersion("2.3.0"), "v2.3.0");
    for (const bad of ["../../evil", "--force", "latest", "v2.3", ""]) {
      assert.throws(() => normalizeTreehouseVersion(bad), /Expected a release/);
    }
  });

  test("install args accept flags in any position and both --version forms", () => {
    assert.deepEqual(parseTreehouseInstallArgs([]), { force: false });
    assert.deepEqual(parseTreehouseInstallArgs(["--force"]), { force: true });
    assert.deepEqual(parseTreehouseInstallArgs(["--version=v2.4.0"]), { force: false, version: "v2.4.0" });
    assert.deepEqual(parseTreehouseInstallArgs(["--version", "v2.4.0", "--force"]), { force: true, version: "v2.4.0" });
    assert.deepEqual(parseTreehouseInstallArgs(["--version="]), { force: false });
    for (const bad of [["--bogus"], ["--version"], ["--version", "--force"], ["v2.4.0"]]) {
      assert.throws(() => parseTreehouseInstallArgs(bad), /Usage: aos treehouse install/);
    }
  });

  test("support check accepts the pinned version and rejects old or unknown ones", () => {
    assert.equal(isSupportedTreehouseVersion(`treehouse ${TREEHOUSE_PINNED_VERSION}`), true);
    assert.equal(isSupportedTreehouseVersion("treehouse v1.4.0"), false);
    assert.equal(isSupportedTreehouseVersion(""), false);
    assert.equal(isSupportedTreehouseVersion(undefined), false);
  });
});

describe("resolveTreehouseCmd", () => {
  test("an explicit AOS_TREEHOUSE_CMD wins over everything", () => {
    const saved = process.env.AOS_TREEHOUSE_CMD;
    process.env.AOS_TREEHOUSE_CMD = join(base, "explicit-treehouse");
    try {
      assert.equal(resolveTreehouseCmd(), join(base, "explicit-treehouse"));
    } finally {
      if (saved === undefined) delete process.env.AOS_TREEHOUSE_CMD;
      else process.env.AOS_TREEHOUSE_CMD = saved;
    }
  });

  test("falls back to the vendored binary, then to PATH", () => {
    const saved = process.env.AOS_TREEHOUSE_CMD;
    const savedRoot = process.env.AOS_ROOT;
    delete process.env.AOS_TREEHOUSE_CMD;
    const root = join(base, "aos-root");
    process.env.AOS_ROOT = root;
    try {
      assert.equal(resolveTreehouseCmd(), "treehouse");
      assert.equal(vendoredTreehousePath(), join(root, "bin", "treehouse"));
      mkdirSync(join(root, "bin"), { recursive: true });
      writeFileSync(join(root, "bin", "treehouse"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(root, "bin", "treehouse"), 0o755);
      assert.equal(resolveTreehouseCmd(), join(root, "bin", "treehouse"));
    } finally {
      if (saved === undefined) delete process.env.AOS_TREEHOUSE_CMD;
      else process.env.AOS_TREEHOUSE_CMD = saved;
      if (savedRoot === undefined) delete process.env.AOS_ROOT;
      else process.env.AOS_ROOT = savedRoot;
    }
  });
});

describe("installTreehouse", () => {
  test("reuses an existing working binary without downloading", () => {
    const binDir = join(base, "bin-reuse");
    mkdirSync(binDir, { recursive: true });
    const dest = join(binDir, "treehouse");
    writeFileSync(dest, "#!/bin/sh\necho 'treehouse v2.3.0'\n");
    chmodSync(dest, 0o755);
    assert.deepEqual(installTreehouse({ binDir }), { path: dest, fresh: false });
    assert.equal(existsSync(join(base, "bin-reuse", "treehouse")), true);
  });
});
