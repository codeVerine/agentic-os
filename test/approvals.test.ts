import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { type ApprovalIo, ensureApproved, isApproved } from "../src/approvals.ts";
import { AosError } from "../src/errors.ts";
import { aosPaths } from "../src/paths.ts";

function io(answer: string | null): ApprovalIo & { questions: string[] } {
  const questions: string[] = [];
  return {
    questions,
    interactive: answer !== null,
    ask: async (question) => {
      questions.push(question);
      return answer ?? "";
    },
  };
}

describe("ensureApproved", () => {
  const base = mkdtempSync(join(tmpdir(), "aos-approvals-"));
  after(() => rmSync(base, { recursive: true, force: true }));
  const file = aosPaths(base).approvedFolders;

  test("asks for an unapproved folder, showing the full path, and records a yes", async () => {
    const terminal = io("y");
    await ensureApproved(file, "/work/app", terminal);
    assert.equal(terminal.questions.length, 1);
    assert.match(terminal.questions[0] ?? "", /\/work\/app read-write/);
    assert.equal(isApproved(file, "/work/app"), true);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });

  test("never asks again for an approved folder, even without a terminal", async () => {
    const terminal = io("n");
    await ensureApproved(file, "/work/app", terminal);
    await ensureApproved(file, "/work/app", io(null));
    assert.deepEqual(terminal.questions, []);
  });

  test("keeps approvals exact: a parent or child of an approved folder is asked about", async () => {
    for (const other of ["/work", "/work/app/sub", "/work/app2"]) {
      const terminal = io("n");
      await assert.rejects(ensureApproved(file, other, terminal), AosError);
      assert.equal(terminal.questions.length, 1);
    }
  });

  test("declining, or anything but yes, records nothing and refuses", async () => {
    for (const answer of ["", "n", "no", "maybe"]) {
      await assert.rejects(ensureApproved(file, "/work/declined", io(answer)), /was not approved/);
    }
    assert.equal(isApproved(file, "/work/declined"), false);
  });

  test("refuses an unapproved folder when there is no terminal, without asking", async () => {
    const terminal = io(null);
    await assert.rejects(ensureApproved(file, "/work/scripted", terminal), /no terminal/);
    assert.deepEqual(terminal.questions, []);
    assert.equal(isApproved(file, "/work/scripted"), false);
  });

  test("accepts yes in any case and keeps earlier approvals when adding one", async () => {
    await ensureApproved(file, "/work/second", io(" YES "));
    assert.equal(isApproved(file, "/work/app"), true);
    assert.equal(isApproved(file, "/work/second"), true);
    assert.equal(readFileSync(file, "utf8"), "/work/app\n/work/second\n");
  });

  test("does not create the approvals file until something is approved", async () => {
    const fresh = aosPaths(join(base, "fresh")).approvedFolders;
    await assert.rejects(ensureApproved(fresh, "/x", io("n")), AosError);
    assert.equal(existsSync(fresh), false);
  });
});
