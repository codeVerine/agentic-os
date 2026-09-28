import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { contextHash, imageProblem } from "../src/docker.ts";

describe("contextHash", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-context-"));
  after(() => rmSync(root, { recursive: true, force: true }));

  const context = (name: string, files: Record<string, string>): string => {
    const dir = join(root, name);
    mkdirSync(dir);
    for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
    return dir;
  };

  test("is stable for identical contents and changes when any file changes", () => {
    const a = context("a", { Dockerfile: "FROM node", "codex-refresh.mjs": "one" });
    const b = context("b", { "codex-refresh.mjs": "one", Dockerfile: "FROM node" });
    const edited = context("edited", { Dockerfile: "FROM node", "codex-refresh.mjs": "two" });
    const added = context("added", { Dockerfile: "FROM node", "codex-refresh.mjs": "one", "extra.sh": "" });
    const renamed = context("renamed", { Dockerfile: "FROM node", "codex-refresh2.mjs": "one" });
    assert.equal(contextHash(a), contextHash(b));
    for (const other of [edited, added, renamed]) assert.notEqual(contextHash(other), contextHash(a));
  });
});

describe("imageProblem", () => {
  const ids = { uid: 501, gid: 20 };
  const current = { User: "501:20", Labels: { "aos.context-hash": "abc" } };

  test("accepts an image built for this user from the shipped context", () => {
    assert.equal(imageProblem(current, ids, "abc"), undefined);
  });

  test("asks for a build when the image is missing", () => {
    assert.match(imageProblem(undefined, ids, "abc") ?? "", /is not built\. Run "aos image build" first/);
  });

  test("asks for a rebuild when the image user differs", () => {
    assert.match(imageProblem({ ...current, User: "" }, ids, "abc") ?? "", /runs as root, but this Mac user is 501:20/);
  });

  test("asks for a rebuild when the context hash label is missing or different", () => {
    for (const config of [{ User: "501:20", Labels: null }, { User: "501:20" }, { ...current, Labels: { "aos.context-hash": "old" } }]) {
      assert.match(imageProblem(config, ids, "abc") ?? "", /different version of aos's docker\/ directory\. Run "aos image build" again/);
    }
  });
});
