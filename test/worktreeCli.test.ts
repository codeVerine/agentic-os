import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { aosPaths, locateProject } from "../src/paths.ts";
import type { WorktreeRecord } from "../src/registry.ts";
import { initCommittedRepo } from "./helpers.ts";

// A fake treehouse binary lets these tests exercise the lease and return paths without the real CLI
// installed. It logs every call, leases whatever path AOS_FAKE_LEASE_PATH names, reports
// AOS_FAKE_STATUS as its pool status (failing instead when AOS_FAKE_STATUS_FAIL is set, after sleeping
// AOS_FAKE_STATUS_DELAY seconds and running the AOS_FAKE_STATUS_HOOK shell snippet), and fails `return`
// for any path containing "fail-return".
// Like the real one, `return` detaches the worktree and refuses when --if-lease-id differs from the
// current lease (AOS_FAKE_LEASE_ID, "fake-lease" by default). The env var must be set before
// treehouse.ts is first evaluated, which worktree.ts does on import, so worktree.ts is imported
// dynamically below.
const base = realpathSync(mkdtempSync(join(tmpdir(), "aos-worktree-cli-")));
after(() => rmSync(base, { recursive: true, force: true }));

const treehouseLog = join(base, "treehouse.log");
const treehouseRootLog = join(base, "treehouse-root.log");
const fakeTreehouse = join(base, "fake-treehouse");
writeFileSync(
  fakeTreehouse,
  `#!/bin/sh
echo "$@" >> "${treehouseLog}"
echo "$TREEHOUSE_ROOT" >> "${treehouseRootLog}"
case "$1" in
  get) printf '{"path":"%s","lease_id":"fake-lease"}\\n' "$AOS_FAKE_LEASE_PATH" ;;
  return)
    case "$2" in *fail-return*) echo "return refused" >&2; exit 1 ;; esac
    path=$2
    while [ $# -gt 0 ]; do
      if [ "$1" = "--if-lease-id" ] && [ "$2" != "\${AOS_FAKE_LEASE_ID:-fake-lease}" ]; then
        echo "failed to return worktree: lease precondition failed: lease identity does not match worktree $path" >&2
        exit 1
      fi
      shift
    done
    git -C "$path" checkout -q --detach 2>/dev/null ;;
  status)
    [ -n "$AOS_FAKE_STATUS_HOOK" ] && sh -c "$AOS_FAKE_STATUS_HOOK"
    [ -n "$AOS_FAKE_STATUS_DELAY" ] && sleep "$AOS_FAKE_STATUS_DELAY"
    [ -n "$AOS_FAKE_STATUS_FAIL" ] && { echo "status unavailable" >&2; exit 1; }
    printf '%s\\n' "\${AOS_FAKE_STATUS:-[]}" ;;
esac
exit 0
`,
);
chmodSync(fakeTreehouse, 0o755);
process.env.AOS_TREEHOUSE_CMD = fakeTreehouse;
const hostTreehouseRoot = join(base, "custom-pool");
process.env.TREEHOUSE_ROOT = hostTreehouseRoot;

function treehouseCalls(): string[] {
  return existsSync(treehouseLog) ? readFileSync(treehouseLog, "utf8").trim().split("\n") : [];
}

const { resolveWorktreeTarget } = await import("../src/worktree.ts");
const { projectKey, withRegistryLock, readRegistry } = await import("../src/registry.ts");
const { worktreeCommand } = await import("../src/worktreeCli.ts");
// cli.ts strips process.env before any treehouse call; treehouse must still see the host's pool root.
delete process.env.TREEHOUSE_ROOT;

interface Repo {
  readonly main: string;
  readonly paths: ReturnType<typeof aosPaths>;
  readonly key: string;
}

function repo(name: string): Repo {
  const main = initCommittedRepo(join(base, name));
  const paths = aosPaths(join(base, `${name}-root`));
  return { main, paths, key: projectKey(main) };
}

function branchWorktree(repoInfo: Repo, id: string): WorktreeRecord {
  const branch = `aos/claude/${id}`;
  const worktreePath = join(base, `wt-${id}`);
  execFileSync("git", ["-C", repoInfo.main, "worktree", "add", "--quiet", "-b", branch, worktreePath]);
  return {
    id,
    agent: "claude",
    branch,
    worktreePath,
    sandboxName: `x-${id}`,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    leaseId: "fake-lease",
  };
}

async function seed(repoInfo: Repo, record: WorktreeRecord): Promise<void> {
  await withRegistryLock(repoInfo.paths, repoInfo.key, (records) => ({ records: [...records, record], value: undefined }));
}

describe("aos worktree list/merge/rm/prune", () => {
  test("list prints without throwing for an empty and a populated registry", async () => {
    const r = repo("list-empty");
    assert.equal(await worktreeCommand(["list"], r.main, r.paths), 0);

    const record = branchWorktree(r, "list-1");
    await seed(r, record);
    assert.equal(await worktreeCommand(["list"], r.main, r.paths), 0);
  });

  test("treehouse runs with the host's TREEHOUSE_ROOT even after process.env is stripped", async () => {
    const r = repo("treehouse-root");
    await seed(r, branchWorktree(r, "root-1"));
    rmSync(treehouseRootLog, { force: true });
    assert.equal(await worktreeCommand(["list"], r.main, r.paths), 0);
    assert.deepEqual(readFileSync(treehouseRootLog, "utf8").trim().split("\n"), [hostTreehouseRoot]);
  });

  test("merge lands the branch's commits on the current branch, without touching the registry", async () => {
    const r = repo("merge");
    const record = branchWorktree(r, "merge-1");
    await seed(r, record);
    writeFileSync(join(record.worktreePath, "file.txt"), "agent change");
    execFileSync("git", ["-C", record.worktreePath, "add", "file.txt"]);
    execFileSync("git", ["-C", record.worktreePath, "commit", "--quiet", "-m", "agent change"]);

    assert.equal(await worktreeCommand(["merge", record.id], r.main, r.paths), 0);
    assert.ok(execFileSync("git", ["-C", r.main, "log", "--oneline"], { encoding: "utf8" }).includes("agent change"));
    assert.equal(readRegistry(r.paths, r.key).length, 1);
  });

  test("merge run from inside the worktree itself lands the branch in the main checkout, and rm then succeeds", async () => {
    const r = repo("merge-from-worktree");
    const record = branchWorktree(r, "merge-wt-1");
    await seed(r, record);
    writeFileSync(join(record.worktreePath, "file.txt"), "agent change");
    execFileSync("git", ["-C", record.worktreePath, "add", "file.txt"]);
    execFileSync("git", ["-C", record.worktreePath, "commit", "--quiet", "-m", "agent change"]);

    assert.equal(await worktreeCommand(["merge", record.id], record.worktreePath, r.paths), 0);
    assert.ok(execFileSync("git", ["-C", r.main, "log", "--oneline"], { encoding: "utf8" }).includes("agent change"));

    assert.equal(await worktreeCommand(["rm", record.id], record.worktreePath, r.paths), 0);
    assert.equal(readRegistry(r.paths, r.key).length, 0);
  });

  test("merge refuses an unknown id", async () => {
    const r = repo("merge-unknown");
    await assert.rejects(worktreeCommand(["merge", "does-not-exist"], r.main, r.paths), /No aos worktree/);
  });

  test("rm refuses uncommitted work without --force, and removes it with --force", async () => {
    const r = repo("rm-dirty");
    const record = branchWorktree(r, "rm-dirty-1");
    await seed(r, record);
    writeFileSync(join(record.worktreePath, "file.txt"), "uncommitted");

    await assert.rejects(worktreeCommand(["rm", record.id], r.main, r.paths), /uncommitted changes/);
    assert.equal(readRegistry(r.paths, r.key).length, 1);

    assert.equal(await worktreeCommand(["rm", record.id, "--force"], r.main, r.paths), 0);
    assert.equal(readRegistry(r.paths, r.key).length, 0);
  });

  test("rm refuses unmerged work without --force, and succeeds once merged", async () => {
    const r = repo("rm-unmerged");
    const record = branchWorktree(r, "rm-unmerged-1");
    await seed(r, record);
    writeFileSync(join(record.worktreePath, "file.txt"), "agent change");
    execFileSync("git", ["-C", record.worktreePath, "add", "file.txt"]);
    execFileSync("git", ["-C", record.worktreePath, "commit", "--quiet", "-m", "agent change"]);

    await assert.rejects(worktreeCommand(["rm", record.id], r.main, r.paths), /not merged/);

    await worktreeCommand(["merge", record.id], r.main, r.paths);
    assert.equal(await worktreeCommand(["rm", record.id], r.main, r.paths), 0);
    assert.equal(readRegistry(r.paths, r.key).length, 0);
    const branches = execFileSync("git", ["-C", r.main, "branch", "--list", record.branch], { encoding: "utf8" });
    assert.equal(branches.trim(), "");
  });

  test("prune removes merged-and-clean worktrees, keeps unmerged ones, and drops entries missing from disk", async () => {
    const r = repo("prune");
    const mergedClean = branchWorktree(r, "prune-clean");
    await seed(r, mergedClean);
    const unmerged = branchWorktree(r, "prune-unmerged");
    await seed(r, unmerged);
    writeFileSync(join(unmerged.worktreePath, "file.txt"), "agent change");
    execFileSync("git", ["-C", unmerged.worktreePath, "add", "file.txt"]);
    execFileSync("git", ["-C", unmerged.worktreePath, "commit", "--quiet", "-m", "agent change"]);
    const gone: WorktreeRecord = { ...branchWorktree(r, "prune-gone-src"), worktreePath: join(base, "does-not-exist") };
    await seed(r, gone);

    assert.equal(await worktreeCommand(["prune"], r.main, r.paths), 0);

    const remaining = readRegistry(r.paths, r.key);
    assert.deepEqual(
      remaining.map((rec) => rec.id),
      [unmerged.id],
    );
  });

  test("rm and prune run from inside an aos worktree check merges against the main checkout", async () => {
    const r = repo("from-worktree");
    const record = branchWorktree(r, "from-wt-1");
    await seed(r, record);
    writeFileSync(join(record.worktreePath, "file.txt"), "agent change");
    execFileSync("git", ["-C", record.worktreePath, "add", "file.txt"]);
    execFileSync("git", ["-C", record.worktreePath, "commit", "--quiet", "-m", "agent change"]);

    await assert.rejects(worktreeCommand(["rm", record.id], record.worktreePath, r.paths), /not merged/);
    assert.equal(await worktreeCommand(["prune"], record.worktreePath, r.paths), 0);

    assert.deepEqual(
      readRegistry(r.paths, r.key).map((rec) => rec.id),
      [record.id],
    );
    const branchHead = execFileSync("git", ["-C", record.worktreePath, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" });
    assert.equal(branchHead.trim(), record.branch);
  });

  test("prune drops the records it did release and keeps the one whose treehouse return failed", async () => {
    const r = repo("prune-partial");
    const failing = branchWorktree(r, "fail-return-1");
    await seed(r, failing);
    const ok = branchWorktree(r, "prune-partial-ok");
    await seed(r, ok);

    assert.equal(await worktreeCommand(["prune"], r.main, r.paths), 1);

    assert.deepEqual(
      readRegistry(r.paths, r.key).map((rec) => rec.id),
      [failing.id],
    );
  });
});

function heldByThisProcess(record: WorktreeRecord): void {
  process.env.AOS_FAKE_STATUS = JSON.stringify([
    { name: record.id, path: record.worktreePath, status: "leased", lease_id: "fake-lease", lease_holder: `aos-${process.pid}` },
  ]);
}

describe("aos worktree rm/prune with a still-running agent", () => {
  after(() => delete process.env.AOS_FAKE_STATUS);

  test("rm refuses a merged, clean worktree whose aos lease holder is alive, unless --force", async () => {
    const r = repo("rm-live");
    const record = branchWorktree(r, "rm-live-1");
    await seed(r, record);
    heldByThisProcess(record);

    await assert.rejects(worktreeCommand(["rm", record.id], r.main, r.paths), new RegExp(`still in use by running aos process ${process.pid}`));
    assert.equal(readRegistry(r.paths, r.key).length, 1);

    assert.equal(await worktreeCommand(["rm", record.id, "--force"], r.main, r.paths), 0);
    assert.equal(readRegistry(r.paths, r.key).length, 0);
  });

  test("prune skips a merged, clean worktree whose aos lease holder is alive", async () => {
    const r = repo("prune-live");
    const live = branchWorktree(r, "prune-live-1");
    await seed(r, live);
    const idle = branchWorktree(r, "prune-idle-1");
    await seed(r, idle);
    heldByThisProcess(live);

    assert.equal(await worktreeCommand(["prune"], r.main, r.paths), 0);
    assert.deepEqual(
      readRegistry(r.paths, r.key).map((rec) => rec.id),
      [live.id],
    );
  });

  test("prune also skips a worktree a still-running aos process resumed, after the original holder exited", async () => {
    const r = repo("prune-resumed");
    const record = { ...branchWorktree(r, "prune-resumed-1"), activePid: process.pid };
    await seed(r, record);
    process.env.AOS_FAKE_STATUS = JSON.stringify([
      { name: record.id, path: record.worktreePath, status: "leased", lease_id: "fake-lease", lease_holder: "aos-999999999" },
    ]);

    assert.equal(await worktreeCommand(["prune"], r.main, r.paths), 0);
    assert.equal(readRegistry(r.paths, r.key).length, 1);
  });

  test("a recorded pid now reused by a process that started after aos recorded it does not block rm or prune", async () => {
    const longAgo = "2000-01-01T00:00:00.000Z";
    const r = repo("pid-reused");
    const pruned = { ...branchWorktree(r, "pid-reused-prune"), createdAt: longAgo, lastUsedAt: longAgo, activePid: process.pid };
    await seed(r, pruned);
    heldByThisProcess(pruned);
    assert.equal(await worktreeCommand(["prune"], r.main, r.paths), 0);
    assert.equal(readRegistry(r.paths, r.key).length, 0);

    const removed = { ...branchWorktree(r, "pid-reused-rm"), createdAt: longAgo, lastUsedAt: longAgo, activePid: process.pid };
    await seed(r, removed);
    heldByThisProcess(removed);
    assert.equal(await worktreeCommand(["rm", removed.id], r.main, r.paths), 0);
    assert.equal(readRegistry(r.paths, r.key).length, 0);
  });

  test("where ps cannot report a start time, a live holder still keeps rm and prune off the worktree", async () => {
    const fakeBin = join(base, "no-lstart-bin");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(fakeBin, "ps"), "#!/bin/sh\necho 'ps: unknown option' >&2\nexit 1\n");
    chmodSync(join(fakeBin, "ps"), 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath}`;
    try {
      const r = repo("no-lstart");
      const record = branchWorktree(r, "no-lstart-1");
      await seed(r, record);
      heldByThisProcess(record);

      assert.equal(await worktreeCommand(["prune"], r.main, r.paths), 0);
      assert.equal(readRegistry(r.paths, r.key).length, 1);
      await assert.rejects(worktreeCommand(["rm", record.id], r.main, r.paths), /still in use by running aos process/);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

describe("a worktree whose treehouse lease ended outside aos", () => {
  const returnCalls = (): number => treehouseCalls().filter((call) => call.startsWith("return")).length;
  const leasedTo = (record: WorktreeRecord, leaseId: string): string =>
    JSON.stringify([{ name: record.id, path: record.worktreePath, status: "leased", lease_id: leaseId, lease_holder: "aos-999999999" }]);
  after(() => {
    delete process.env.AOS_FAKE_STATUS;
    delete process.env.AOS_FAKE_LEASE_ID;
  });

  test("rm --force leaves the folder and the branch checked out in it alone", async () => {
    const r = repo("stale-rm");
    const record = branchWorktree(r, "stale-rm-1");
    await seed(r, record);
    writeFileSync(join(record.worktreePath, "other-session.txt"), "uncommitted work of the folder's new lease");
    process.env.AOS_FAKE_STATUS = leasedTo(record, "someone-elses-lease");
    const before = returnCalls();

    assert.equal(await worktreeCommand(["rm", record.id, "--force"], r.main, r.paths), 0);

    assert.equal(returnCalls(), before);
    assert.ok(existsSync(join(record.worktreePath, "other-session.txt")));
    const head = execFileSync("git", ["-C", record.worktreePath, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" });
    assert.equal(head.trim(), record.branch);
    assert.equal(readRegistry(r.paths, r.key).length, 0);
  });

  test("prune drops a merged record whose folder was reused and is dirty, and leaves the folder untouched", async () => {
    const r = repo("stale-prune");
    const record = branchWorktree(r, "stale-prune-1");
    await seed(r, record);
    writeFileSync(join(record.worktreePath, "other-session.txt"), "uncommitted work of the folder's new lease");
    process.env.AOS_FAKE_STATUS = leasedTo(record, "someone-elses-lease");
    const before = returnCalls();

    assert.equal(await worktreeCommand(["prune"], r.main, r.paths), 0);

    assert.equal(readRegistry(r.paths, r.key).length, 0);
    assert.equal(returnCalls(), before);
    assert.ok(existsSync(join(record.worktreePath, "other-session.txt")));
    const head = execFileSync("git", ["-C", record.worktreePath, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" });
    assert.equal(head.trim(), record.branch);
  });

  test("treehouse's own lease check stops a return when the pool status could not say", async () => {
    const r = repo("stale-return");
    const record = branchWorktree(r, "stale-return-1");
    await seed(r, record);
    writeFileSync(join(record.worktreePath, "other-session.txt"), "uncommitted work of the folder's new lease");
    delete process.env.AOS_FAKE_STATUS;
    process.env.AOS_FAKE_LEASE_ID = "someone-elses-lease";

    await assert.rejects(worktreeCommand(["rm", record.id, "--force"], r.main, r.paths), /lease precondition failed/);

    assert.ok(existsSync(join(record.worktreePath, "other-session.txt")));
    const head = execFileSync("git", ["-C", record.worktreePath, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" });
    assert.equal(head.trim(), record.branch);
    assert.equal(readRegistry(r.paths, r.key).length, 1);
    delete process.env.AOS_FAKE_LEASE_ID;
  });

  test("resume leases a new worktree instead of entering the folder", async () => {
    const r = repo("stale-resume");
    const record = branchWorktree(r, "stale-resume-1");
    await seed(r, record);
    process.env.AOS_FAKE_STATUS = leasedTo(record, "someone-elses-lease");
    const leased = join(base, "stale-resume-slot");
    execFileSync("git", ["-C", r.main, "worktree", "add", "--quiet", "--detach", leased]);
    process.env.AOS_FAKE_LEASE_PATH = leased;

    const target = await resolveWorktreeTarget("claude", ["--continue"], locateProject(r.main), r.paths, join(base, "stale-resume-agent"));

    assert.equal(target.hostRoot, leased);
  });
});

describe("resuming into a worktree another aos session is running in", () => {
  after(() => delete process.env.AOS_FAKE_STATUS);

  test("is refused with the pid of the running session", async () => {
    const r = repo("resume-live");
    const record = { ...branchWorktree(r, "resume-live-1"), activePid: process.pid };
    await seed(r, record);
    heldByThisProcess(record);

    await assert.rejects(
      resolveWorktreeTarget("claude", ["--continue"], locateProject(r.main), r.paths, join(base, "resume-live-agent")),
      new RegExp(`is in use by running aos process ${process.pid}`),
    );
  });
});

describe("resolveWorktreeTarget", () => {
  test("returns the lease and deletes the new branch when setup fails after leasing", async () => {
    const r = repo("lease-leak");
    const leased = join(base, "lease-leak-slot");
    execFileSync("git", ["-C", r.main, "worktree", "add", "--quiet", "--detach", leased]);
    process.env.AOS_FAKE_LEASE_PATH = leased;
    mkdirSync(join(r.paths.worktrees, ".."), { recursive: true });
    writeFileSync(r.paths.worktrees, "not a directory");

    await assert.rejects(resolveWorktreeTarget("claude", [], locateProject(r.main), r.paths, join(base, "lease-leak-agent")));

    assert.ok(treehouseCalls().includes(`return ${leased} --force --if-lease-id fake-lease`));
    const branches = execFileSync("git", ["-C", r.main, "branch", "--list", "aos/*"], { encoding: "utf8" });
    assert.equal(branches.trim(), "");
  });

  test("an explicit claude session id that ran in the main checkout resumes there instead of leasing", async () => {
    const r = repo("resume-main");
    const project = locateProject(r.main);
    const agentDir = join(base, "resume-main-agent");
    const sessionDir = join(agentDir, "projects", `-home-agent-projects-${project.sandboxName}`);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "session-main.jsonl"), "{}\n");
    const leasesBefore = treehouseCalls().filter((call) => call.startsWith("get")).length;

    const target = await resolveWorktreeTarget("claude", ["--resume", "session-main"], project, r.paths, agentDir);

    assert.deepEqual(target, { hostRoot: project.root, sandboxName: project.sandboxName, branch: undefined, subdir: "" });
    assert.equal(treehouseCalls().filter((call) => call.startsWith("get")).length, leasesBefore);
  });
});

const resumeChild = fileURLToPath(new URL("./fixtures/resumeTarget.ts", import.meta.url));

const statusOf = (record: WorktreeRecord, leaseId = "fake-lease"): string =>
  JSON.stringify([{ name: record.id, path: record.worktreePath, status: "leased", lease_id: leaseId, lease_holder: "aos-999999999" }]);

function slot(r: Repo, name: string): string {
  const path = join(base, name);
  execFileSync("git", ["-C", r.main, "worktree", "add", "--quiet", "--detach", path]);
  return path;
}

interface ResumeOutcome {
  readonly ok: boolean;
  readonly hostRoot?: string;
  readonly error?: string;
}

/** Runs `aos claude --continue` as its own process, which stays alive like a running agent until `stop`. */
function startResume(r: Repo, agentDir: string, env: NodeJS.ProcessEnv = {}): { outcome: Promise<ResumeOutcome>; stop: () => void } {
  const child = spawn(process.execPath, [resumeChild, r.main, "claude", r.paths.root, agentDir, "--continue"], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const outcome = new Promise<ResumeOutcome>((resolve, reject) => {
    createInterface({ input: child.stdout }).once("line", (line) => resolve(JSON.parse(line) as ResumeOutcome));
    child.once("error", reject);
    child.once("exit", () => reject(new Error("resume process exited without reporting")));
  });
  return { outcome, stop: () => child.kill() };
}

describe("resuming a recorded worktree", () => {
  after(() => {
    delete process.env.AOS_FAKE_STATUS;
    delete process.env.AOS_FAKE_STATUS_FAIL;
  });

  test("refuses when treehouse status is unavailable, rather than guessing the folder is still ours", async () => {
    const r = repo("verify-unavailable");
    const record = branchWorktree(r, "verify-unavailable-1");
    await seed(r, record);
    process.env.AOS_FAKE_STATUS_FAIL = "1";

    await assert.rejects(
      resolveWorktreeTarget("claude", ["--continue"], locateProject(r.main), r.paths, join(base, "verify-agent")),
      /treehouse status is unavailable/,
    );
    assert.equal(readRegistry(r.paths, r.key)[0]?.activePid, undefined);
    delete process.env.AOS_FAKE_STATUS_FAIL;
  });

  test("refuses when treehouse does not list the folder at all", async () => {
    const r = repo("verify-unlisted");
    const record = branchWorktree(r, "verify-unlisted-1");
    await seed(r, record);
    process.env.AOS_FAKE_STATUS = "[]";

    await assert.rejects(
      resolveWorktreeTarget("claude", ["--continue"], locateProject(r.main), r.paths, join(base, "verify-agent")),
      /does not list/,
    );
  });

  test("refuses when the recorded branch is not the one checked out in the folder", async () => {
    const r = repo("verify-branch");
    const record = branchWorktree(r, "verify-branch-1");
    await seed(r, record);
    execFileSync("git", ["-C", record.worktreePath, "checkout", "-q", "--detach"]);
    process.env.AOS_FAKE_STATUS = statusOf(record);

    await assert.rejects(
      resolveWorktreeTarget("claude", ["--continue"], locateProject(r.main), r.paths, join(base, "verify-agent")),
      /not on its branch/,
    );
  });

  test("resumes into the recorded worktree at the subdirectory the conversation started in", async () => {
    const r = repo("resume-subdir");
    const record = { ...branchWorktree(r, "resume-subdir-1"), subdir: "packages/app" };
    await seed(r, record);
    process.env.AOS_FAKE_STATUS = statusOf(record);

    const target = await resolveWorktreeTarget("claude", ["--continue"], locateProject(r.main), r.paths, join(base, "verify-agent"));

    assert.equal(target.hostRoot, record.worktreePath);
    assert.equal(target.subdir, "packages/app");
    assert.equal(readRegistry(r.paths, r.key)[0]?.activePid, process.pid);
  });

  test("a record from before subdirectories were kept resumes at the worktree root", async () => {
    const r = repo("resume-no-subdir");
    const record = branchWorktree(r, "resume-no-subdir-1");
    await seed(r, record);
    process.env.AOS_FAKE_STATUS = statusOf(record);
    mkdirSync(join(r.main, "sub"));

    const target = await resolveWorktreeTarget("claude", ["--continue"], locateProject(join(r.main, "sub")), r.paths, join(base, "verify-agent"));

    assert.equal(target.subdir, "");
  });
});

describe("leasing a new worktree", () => {
  test("records the launch subdirectory and leases without fetching the remote", async () => {
    const r = repo("lease-subdir");
    mkdirSync(join(r.main, "packages", "app"), { recursive: true });
    process.env.AOS_FAKE_LEASE_PATH = slot(r, "lease-subdir-slot");
    const before = treehouseCalls().length;

    const target = await resolveWorktreeTarget("claude", [], locateProject(join(r.main, "packages", "app")), r.paths, join(base, "lease-agent"));

    assert.equal(target.subdir, "packages/app");
    assert.equal(readRegistry(r.paths, r.key)[0]?.subdir, "packages/app");
    const lease = treehouseCalls().slice(before).find((call) => call.startsWith("get "));
    assert.ok(lease?.split(" ").includes("--no-fetch"), `treehouse get was run as: ${lease}`);
  });
});

describe("two aos processes resuming and removing the same worktree", () => {
  after(() => {
    delete process.env.AOS_FAKE_STATUS;
    delete process.env.AOS_FAKE_STATUS_HOOK;
  });

  test("resumes started together claim the worktree once", async () => {
    const r = repo("resume-race");
    const record = branchWorktree(r, "resume-race-1");
    await seed(r, record);
    const env = { AOS_FAKE_STATUS: statusOf(record), AOS_FAKE_STATUS_DELAY: "0.5" };
    const runs = [startResume(r, join(base, "race-agent"), env), startResume(r, join(base, "race-agent"), env)];
    try {
      const outcomes = await Promise.all(runs.map((run) => run.outcome));
      assert.deepEqual(outcomes.map((o) => o.ok).sort(), [false, true]);
      assert.match(outcomes.find((o) => !o.ok)?.error ?? "", /in use by running aos process/);
    } finally {
      for (const run of runs) run.stop();
    }
  });

  test("rm re-checks the worktree under the registry lock, so a resume that claims it first wins", async () => {
    const r = repo("rm-race");
    const record = branchWorktree(r, "rm-race-1");
    await seed(r, record);
    process.env.AOS_FAKE_LEASE_PATH = slot(r, "rm-race-slot");
    process.env.AOS_FAKE_STATUS = statusOf(record);
    const out = join(base, "rm-race.out");
    const pidFile = join(base, "rm-race.pid");
    const started = join(base, "rm-race.started");
    // While rm reads the pool status, a second aos starts resuming the same worktree and gets up to
    // two seconds to claim it. Only a rm that holds the registry lock across its checks blocks that claim.
    process.env.AOS_FAKE_STATUS_HOOK =
      `[ -e '${started}' ] && exit 0; touch '${started}'; ` +
      `'${process.execPath}' '${resumeChild}' '${r.main}' claude '${r.paths.root}' '${join(base, "rm-race-agent")}' --continue ` +
      `> '${out}' 2>/dev/null < /dev/null & echo $! > '${pidFile}'; i=0; while [ $i -lt 20 ] && [ ! -s '${out}' ]; do sleep 0.1; i=$((i+1)); done`;
    let resumed: ResumeOutcome | undefined;
    try {
      await worktreeCommand(["rm", record.id], r.main, r.paths).catch(() => 1);
      for (let i = 0; i < 100 && !(existsSync(out) && readFileSync(out, "utf8").includes("\n")); i++) await new Promise((r) => setTimeout(r, 100));
      resumed = JSON.parse(readFileSync(out, "utf8").trim().split("\n")[0] ?? "{}") as ResumeOutcome;
    } finally {
      if (existsSync(pidFile)) process.kill(Number(readFileSync(pidFile, "utf8")));
    }

    assert.notEqual(resumed?.hostRoot, record.worktreePath, "the resumed agent was handed the worktree rm took back");
    assert.ok(resumed?.ok, `the resuming process failed: ${resumed?.error}`);
  });
});

describe("aos worktree rm with status.showUntrackedFiles=no", () => {
  test("refuses a worktree holding a new untracked file without --force", async () => {
    const r = repo("rm-hidden-untracked");
    const record = branchWorktree(r, "rm-hidden-1");
    await seed(r, record);
    execFileSync("git", ["-C", r.main, "config", "status.showUntrackedFiles", "no"]);
    writeFileSync(join(record.worktreePath, "NEW_WORK.md"), "unsaved");

    await assert.rejects(worktreeCommand(["rm", record.id], r.main, r.paths), /uncommitted changes/);
    assert.ok(existsSync(join(record.worktreePath, "NEW_WORK.md")));
  });
});
