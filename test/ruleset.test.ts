import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { applyProtectionRuleset, parseRepoSlug, protectionRuleset } from "../src/ruleset.ts";
import { AosError } from "../src/errors.ts";

describe("protection ruleset", () => {
  test("parses owner/repo slugs and rejects the rest", () => {
    assert.deepEqual(parseRepoSlug("octo/demo"), { owner: "octo", name: "demo" });
    assert.deepEqual(parseRepoSlug("octo/demo.git"), { owner: "octo", name: "demo" });
    assert.throws(() => parseRepoSlug("just-a-name"), AosError);
    assert.throws(() => parseRepoSlug("a/b/c"), AosError);
  });

  test("payload blocks deletions and force pushes on all branches, and nothing else", () => {
    const payload = protectionRuleset();
    assert.equal(payload["name"], "aos");
    assert.equal(payload["target"], "branch");
    assert.equal(payload["enforcement"], "active");
    assert.deepEqual(payload["conditions"], { ref_name: { include: ["~ALL"], exclude: [] } });
    assert.deepEqual(payload["rules"], [{ type: "deletion" }, { type: "non_fast_forward" }]);
    assert.deepEqual(payload["bypass_actors"], []);
  });

  test("--dry-run prints the gh invocation without calling gh", () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => void lines.push(line);
    try {
      applyProtectionRuleset({ owner: "octo", name: "demo" }, true);
    } finally {
      console.log = original;
    }
    assert.match(lines.join("\n"), /gh api --method POST repos\/octo\/demo\/rulesets/);
    assert.match(lines.join("\n"), /non_fast_forward/);
  });
});
