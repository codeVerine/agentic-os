import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { after, describe, test } from "node:test";
import { classifyLandingPath, formatLandingReview, landingReview } from "../src/landing.ts";
import { initCommittedRepo } from "./helpers.ts";
import { writeFileSync, mkdirSync } from "node:fs";

const base = realpathSync(mkdtempSync(join(tmpdir(), "aos-landing-")));
after(() => rmSync(base, { recursive: true, force: true }));

describe("classifyLandingPath", () => {
  test("flags hook scripts, hook-manager configs, gitattributes and package.json", () => {
    assert.match(classifyLandingPath(".husky/pre-commit") ?? "", /hook script/);
    assert.match(classifyLandingPath(".githooks/post-checkout") ?? "", /hook script/);
    assert.match(classifyLandingPath("lefthook.yml") ?? "", /hook-manager/);
    assert.match(classifyLandingPath(".pre-commit-config.yaml") ?? "", /hook-manager/);
    assert.match(classifyLandingPath(".gitattributes") ?? "", /filters/);
    assert.match(classifyLandingPath("package.json") ?? "", /install scripts/);
    assert.match(classifyLandingPath("packages/app/package.json") ?? "", /install scripts/);
  });

  test("ordinary source files are inert", () => {
    assert.equal(classifyLandingPath("src/index.ts"), undefined);
    assert.equal(classifyLandingPath("README.md"), undefined);
    assert.equal(classifyLandingPath("husky-not-a-dir.txt"), undefined);
  });
});

describe("landingReview", () => {
  test("groups exactly the risky files changed on the branch", () => {
    const repo = initCommittedRepo(join(base, "review"));
    const main = execFileSync("git", ["-C", repo, "branch", "--show-current"], { encoding: "utf8" }).trim();
    execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "aos/claude/x"]);
    mkdirSync(join(repo, ".husky"), { recursive: true });
    writeFileSync(join(repo, ".husky", "pre-commit"), "npm test\n");
    writeFileSync(join(repo, "lefthook.yml"), "pre-commit:\n");
    writeFileSync(join(repo, "src.ts"), "x\n");
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "commit", "-qm", "agent work"]);
    execFileSync("git", ["-C", repo, "checkout", "-q", main]);
    const review = landingReview(repo, "aos/claude/x");
    assert.equal(review.changed, 3);
    assert.deepEqual(
      review.risks.map((r) => r.path).sort(),
      [".husky/pre-commit", "lefthook.yml"],
    );
    const block = formatLandingReview("aos/claude/x", review);
    assert.match(block, /landing review for aos\/claude\/x \(3 files changed\)/);
    assert.match(block, /\.husky\/pre-commit/);
  });

  test("a branch with no risky files formats to nothing", () => {
    const repo = initCommittedRepo(join(base, "clean"));
    const main = execFileSync("git", ["-C", repo, "branch", "--show-current"], { encoding: "utf8" }).trim();
    execFileSync("git", ["-C", repo, "checkout", "-q", "-b", "aos/pi/y"]);
    writeFileSync(join(repo, "app.ts"), "y\n");
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "commit", "-qm", "agent work"]);
    execFileSync("git", ["-C", repo, "checkout", "-q", main]);
    const review = landingReview(repo, "aos/pi/y");
    assert.equal(review.risks.length, 0);
    assert.equal(formatLandingReview("aos/pi/y", review), "");
  });
});
