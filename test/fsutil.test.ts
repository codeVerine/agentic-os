import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { withFileLock } from "../src/fsutil.ts";

describe("withFileLock", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "aos-fsutil-")));
  after(() => rmSync(base, { recursive: true, force: true }));

  test("a holder still running past the stale age keeps its lock", async () => {
    const lock = join(base, "slow.lock");
    const events: string[] = [];
    const holder = withFileLock(
      lock,
      async () => {
        events.push("holder in");
        await sleep(700);
        events.push("holder out");
      },
      200,
    );
    await sleep(100);
    const contender = withFileLock(lock, async () => void events.push("contender in"), 200);
    await Promise.all([holder, contender]);
    assert.deepEqual(events, ["holder in", "holder out", "contender in"]);
  });

  test("a lock left behind by a holder that died is taken over after the stale age", async () => {
    const lock = join(base, "abandoned.lock");
    writeFileSync(lock, "dead-holder");
    const longAgo = new Date(Date.now() - 60_000);
    utimesSync(lock, longAgo, longAgo);
    assert.equal(await withFileLock(lock, async () => "taken", 200), "taken");
  });
});
