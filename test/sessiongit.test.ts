import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { aosPaths, gitCommonDir } from "../src/paths.ts";
import type { WorktreeRecord } from "../src/registry.ts";
import { initCommittedRepo, writeFakeDocker } from "./helpers.ts";

// The fake docker must be named before src/sessiongit.ts is first evaluated, which reads it at load.
const base = realpathSync(mkdtempSync(join(tmpdir(), "aos-sessiongit-")));
after(() => rmSync(base, { recursive: true, force: true }));
const fakeDocker = writeFakeDocker(base);
process.env.AOS_DOCKER_CMD = fakeDocker.cmd;

const {
  createSessionGitDir,
  objectDirs,
  readSessionHeadBranch,
  readSessionTip,
  removeSessionGitDir,
  sessionGitMounts,
  sessionGitPaths,
  syncSession,
  watchForChange,
  HOST_GIT_MOUNT,
} = await import("../src/sessiongit.ts");
const { projectKey, readRegistry, withRegistryLock } = await import("../src/registry.ts");

const IDENTITY = ["-c", "user.name=Agent", "-c", "user.email=agent@example.com"];

const git = (dir: string, ...args: string[]): string => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
const gitDirCmd = (gitDir: string, worktree: string, ...args: string[]): string =>
  execFileSync("git", [...IDENTITY, "--git-dir", gitDir, "--work-tree", worktree, ...args], { encoding: "utf8" }).trim();
const dockerCalls = (): string[][] =>
  existsSync(fakeDocker.log) ? readFileSync(fakeDocker.log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]) : [];

let counter = 0;

function setup(name: string) {
  const main = initCommittedRepo(join(base, name));
  writeFileSync(join(main, "file.txt"), "one\n");
  git(main, "add", "file.txt");
  git(main, "commit", "--quiet", "-m", "first");
  git(main, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(main, "tag", "v1");
  git(main, "branch", "other");
  git(main, "config", "core.hooksPath", ".githooks");
  git(main, "config", "remote.origin.url", "https://github.com/acme/widgets.git");
  const hooks = join(main, ".git", "hooks");
  writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(hooks, "pre-commit"), 0o755);
  writeFileSync(join(hooks, "commit-msg.sample"), "sample\n");
  symlinkSync("/nonexistent/target", join(hooks, "post-merge"));
  writeFileSync(join(main, ".git", "info", "exclude"), "ignored.txt\n");

  const id = `20261013T000000-${(counter++).toString(16).padStart(6, "0")}`;
  const branch = `aos/pi/${id}`;
  const slot = join(base, `${name}-slot`);
  git(main, "worktree", "add", "--quiet", "-b", branch, slot);
  const paths = aosPaths(join(base, `${name}-root`));
  const key = projectKey(main);
  const session = sessionGitPaths(paths, key, id);
  const commonDir = gitCommonDir(main);
  const baseRev = git(main, "rev-parse", "HEAD");
  createSessionGitDir({ mainRoot: main, commonDir, worktreePath: slot, session, branch, baseRev });
  return { main, commonDir, slot, paths, key, session, branch, baseRev, id };
}

type Setup = ReturnType<typeof setup>;

async function seedRecord(s: Setup): Promise<void> {
  const record: WorktreeRecord = {
    id: s.id,
    agent: "pi",
    branch: s.branch,
    worktreePath: s.slot,
    sandboxName: `x-${s.id}`,
    importedTip: s.baseRev,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    leaseId: "lease",
  };
  await withRegistryLock(s.paths, s.key, (records) => ({ records: [...records, record], value: undefined }));
}

function agentCommit(s: Setup, file: string, content: string, message: string): string {
  writeFileSync(join(s.slot, file), content);
  gitDirCmd(s.session.gitDir, s.slot, "add", file);
  gitDirCmd(s.session.gitDir, s.slot, "commit", "--quiet", "-m", message);
  return gitDirCmd(s.session.gitDir, s.slot, "rev-parse", "HEAD");
}

function sync(s: Setup) {
  mkdirSync(s.paths.run, { recursive: true });
  return syncSession({ paths: s.paths, key: s.key, commonDir: s.commonDir, worktreePath: s.slot, session: s.session, scratchDir: s.paths.run });
}

describe("createSessionGitDir", () => {
  test("starts from the approved config and hooks, borrows objects, and keeps refs to what the session needs", () => {
    const s = setup("create");
    const config = readFileSync(join(s.session.gitDir, "config"), "utf8");
    assert.match(config, /hooksPath = \.githooks/);
    assert.match(config, /url = https:\/\/github\.com\/acme\/widgets\.git/);
    assert.match(config, /bare = false/);
    assert.equal(gitDirCmd(s.session.gitDir, s.slot, "config", "--get", "remote.host.url"), HOST_GIT_MOUNT);

    assert.ok(existsSync(join(s.session.gitDir, "hooks", "pre-commit")));
    assert.equal(lstatSync(join(s.session.gitDir, "hooks", "pre-commit")).mode & 0o111, 0o111);
    assert.equal(existsSync(join(s.session.gitDir, "hooks", "commit-msg.sample")), false);
    assert.equal(existsSync(join(s.session.gitDir, "hooks", "post-merge")), false);
    assert.equal(readFileSync(join(s.session.gitDir, "info", "exclude"), "utf8"), "ignored.txt\n");
    assert.equal(readFileSync(join(s.session.gitDir, "objects", "info", "alternates"), "utf8"), `${join(s.commonDir, "objects")}\n`);
    assert.equal(readFileSync(s.session.gitFile, "utf8"), `gitdir: ${s.session.gitDir}\n`);

    const refs = gitDirCmd(s.session.gitDir, s.slot, "for-each-ref", "--format=%(refname)").split("\n").sort();
    assert.deepEqual(refs, [`refs/heads/${s.branch}`, "refs/remotes/origin/main", "refs/tags/v1"]);
    assert.equal(readSessionHeadBranch(s.session), s.branch);
  });

  test("the folder reads clean through the session's git directory", () => {
    const s = setup("clean");
    assert.equal(gitDirCmd(s.session.gitDir, s.slot, "status", "--porcelain"), "");
  });

  test("an agent commit lands in the session's git directory and nothing in the repository's changes", () => {
    const s = setup("isolated");
    const snapshot = (): string =>
      [git(s.main, "for-each-ref"), readFileSync(join(s.commonDir, "config"), "utf8"), readFileSync(join(s.commonDir, "hooks", "pre-commit"), "utf8")].join("\n---\n");
    const before = snapshot();
    const tip = agentCommit(s, "agent.txt", "agent\n", "agent work");
    assert.equal(readSessionTip(s.session, s.branch), tip);
    assert.equal(snapshot(), before);
    assert.equal(git(s.main, "rev-parse", `refs/heads/${s.branch}`), s.baseRev);
  });

  test("follows alternates the repository itself borrows from", () => {
    const main = initCommittedRepo(join(base, "chained-main"));
    const donor = join(base, "chained-donor", "objects");
    mkdirSync(join(donor, "info"), { recursive: true });
    writeFileSync(join(main, ".git", "objects", "info", "alternates"), `${donor}\n`);
    assert.deepEqual(objectDirs(gitCommonDir(main)), [join(gitCommonDir(main), "objects"), donor]);
  });

  test("removes cleanly and leaves no staging directory when it fails", () => {
    const s = setup("remove");
    removeSessionGitDir(s.session);
    assert.equal(existsSync(s.session.gitDir), false);
    assert.equal(existsSync(s.session.gitFile), false);

    const main = initCommittedRepo(join(base, "failing"));
    const paths = aosPaths(join(base, "failing-root"));
    const session = sessionGitPaths(paths, "k", "id-1");
    assert.throws(() =>
      createSessionGitDir({ mainRoot: main, commonDir: gitCommonDir(main), worktreePath: main, session, branch: "aos/x", baseRev: "0".repeat(40) }),
    );
    assert.equal(existsSync(session.gitDir), false);
    assert.deepEqual(existsSync(join(paths.gitdirs, "k")) ? readdirNames(join(paths.gitdirs, "k")) : [], []);
  });
});

function readdirNames(dir: string): string[] {
  return execFileSync("ls", ["-A", dir], { encoding: "utf8" }).split("\n").filter(Boolean);
}

describe("sessionGitMounts", () => {
  test("exposes the repository's git directory only read-only, and the worktree's .git file read-only", () => {
    const s = setup("mounts");
    const mounts = sessionGitMounts(s.commonDir, s.session, s.slot, "/home/agent/projects/p");
    const writable = mounts.filter((m) => m.readonly !== true).map((m) => m.hostPath);
    assert.deepEqual(writable, [s.slot, s.session.gitDir]);
    const dotGit = mounts.find((m) => m.sandboxPath === "/home/agent/projects/p/.git");
    assert.deepEqual(dotGit, { hostPath: s.session.gitFile, sandboxPath: "/home/agent/projects/p/.git", readonly: true });
    assert.ok(mounts.some((m) => m.hostPath === join(s.commonDir, "objects") && m.sandboxPath === join(s.commonDir, "objects") && m.readonly === true));
    assert.ok(mounts.some((m) => m.hostPath === s.commonDir && m.sandboxPath === HOST_GIT_MOUNT && m.readonly === true));
    assert.ok(!mounts.some((m) => m.sandboxPath === s.commonDir));
  });

  test("refuses paths Docker bind mounts cannot express", () => {
    const s = setup("mounts-colon");
    const bad = { ...s.session, gitDir: `${s.session.gitDir}:x` };
    assert.throws(() => sessionGitMounts(s.commonDir, bad, s.slot, "/home/agent/projects/p"), /Docker bind mounts/);
  });
});

describe("readSessionTip", () => {
  test("reads a loose ref, then packed-refs, as data", () => {
    const s = setup("tip");
    const tip = agentCommit(s, "a.txt", "a\n", "a");
    assert.equal(readSessionTip(s.session, s.branch), tip);
    gitDirCmd(s.session.gitDir, s.slot, "pack-refs", "--all", "--prune");
    assert.equal(existsSync(join(s.session.gitDir, "refs", "heads", s.branch)), false);
    assert.equal(readSessionTip(s.session, s.branch), tip);
  });

  test("never follows a symlink an agent planted on the way", () => {
    const s = setup("tip-symlink");
    const elsewhere = join(base, "tip-symlink-elsewhere");
    mkdirSync(join(elsewhere, "pi"), { recursive: true });
    writeFileSync(join(elsewhere, "pi", s.id), `${"a".repeat(40)}\n`);
    rmSync(join(s.session.gitDir, "refs", "heads", "aos"), { recursive: true, force: true });
    symlinkSync(elsewhere, join(s.session.gitDir, "refs", "heads", "aos"));
    assert.equal(readSessionTip(s.session, s.branch), undefined);
  });

  test("ignores a ref file that is not an object id", () => {
    const s = setup("tip-garbage");
    writeFileSync(join(s.session.gitDir, "refs", "heads", "aos", "pi", s.id), "not a ref\n");
    assert.equal(readSessionTip(s.session, s.branch), undefined);
  });
});

describe("syncSession", () => {
  test("imports agent commits through a network-less container and records the imported tip", async () => {
    const s = setup("sync");
    await seedRecord(s);
    const tip = agentCommit(s, "agent.txt", "agent\n", "agent work");
    const before = dockerCalls().length;

    const { outcome, record } = await sync(s);

    assert.equal(outcome.kind, "imported");
    assert.equal(git(s.main, "rev-parse", `refs/heads/${s.branch}`), tip);
    assert.equal(record.importedTip, tip);
    assert.equal(readRegistry(s.paths, s.key)[0]?.importedTip, tip);
    assert.equal(git(s.slot, "status", "--porcelain"), "");
    assert.equal(git(s.main, "for-each-ref", "refs/aos"), "");
    const call = dockerCalls()[before] ?? [];
    assert.deepEqual(call.slice(0, 5), ["run", "--rm", "--network", "none", "--cap-drop"]);
    assert.ok(call.includes(`${s.session.gitDir}:${s.session.gitDir}:ro`));
    assert.ok(call.includes(`${join(s.commonDir, "objects")}:${join(s.commonDir, "objects")}:ro`));
  });

  test("starts no container when the session has nothing new", async () => {
    const s = setup("sync-idle");
    await seedRecord(s);
    const before = dockerCalls().length;
    assert.equal((await sync(s)).outcome.kind, "unchanged");
    assert.equal(dockerCalls().length, before);
  });

  test("imports a rewritten session history over the tip it imported last", async () => {
    const s = setup("sync-rewrite");
    await seedRecord(s);
    agentCommit(s, "a.txt", "a\n", "a");
    agentCommit(s, "b.txt", "b\n", "b");
    await sync(s);
    gitDirCmd(s.session.gitDir, s.slot, "reset", "--quiet", "--hard", "HEAD~2");
    const rewritten = agentCommit(s, "c.txt", "c\n", "c");

    const { outcome } = await sync(s);

    assert.equal(outcome.kind, "imported");
    assert.equal(git(s.main, "rev-parse", `refs/heads/${s.branch}`), rewritten);
  });

  test("keeps commits made on the Mac and puts a session that does not contain them on a new branch", async () => {
    const s = setup("sync-diverge");
    await seedRecord(s);
    await sync(s);
    writeFileSync(join(s.slot, "mac.txt"), "mac\n");
    git(s.slot, "add", "mac.txt");
    git(s.slot, ...IDENTITY, "commit", "--quiet", "-m", "made on the mac");
    const macTip = git(s.main, "rev-parse", `refs/heads/${s.branch}`);
    const sessionTip = agentCommit(s, "agent.txt", "agent\n", "agent work");

    const { outcome, record } = await sync(s);

    assert.equal(outcome.kind === "imported" && outcome.diverged, true);
    assert.equal(git(s.main, "rev-parse", `refs/heads/${s.branch}`), macTip);
    assert.equal(git(s.main, "rev-parse", `refs/heads/${s.branch}-1`), sessionTip);
    assert.equal(record.importBranch, `${s.branch}-1`);

    const next = agentCommit(s, "more.txt", "more\n", "more work");
    const second = await sync(s);
    assert.equal(second.outcome.kind === "imported" && second.outcome.diverged, false);
    assert.equal(git(s.main, "rev-parse", `refs/heads/${s.branch}-1`), next);
    assert.equal(git(s.main, "rev-parse", `refs/heads/${s.branch}`), macTip);
    assert.equal(git(s.main, "branch", "--list", `${s.branch}-2`), "");
  });

  test("fast-forwards when the session already contains the commits made on the Mac", async () => {
    const s = setup("sync-contains");
    await seedRecord(s);
    writeFileSync(join(s.slot, "mac.txt"), "mac\n");
    git(s.slot, "add", "mac.txt");
    git(s.slot, ...IDENTITY, "commit", "--quiet", "-m", "made on the mac");
    const macTip = git(s.main, "rev-parse", `refs/heads/${s.branch}`);
    gitDirCmd(s.session.gitDir, s.slot, "fetch", "--quiet", s.commonDir, `+refs/heads/${s.branch}:refs/remotes/host/${s.branch}`);
    gitDirCmd(s.session.gitDir, s.slot, "reset", "--quiet", "--mixed", macTip);
    const sessionTip = agentCommit(s, "agent.txt", "agent\n", "agent work");

    const { outcome } = await sync(s);

    assert.equal(outcome.kind === "imported" && outcome.diverged, false);
    assert.equal(git(s.main, "rev-parse", `refs/heads/${s.branch}`), sessionTip);
    assert.equal(git(s.main, "merge-base", "--is-ancestor", macTip, sessionTip), "");
  });

  test("a branch deleted on the Mac is reported and the session keeps its commits", async () => {
    const s = setup("sync-fail");
    await seedRecord(s);
    agentCommit(s, "agent.txt", "agent\n", "agent work");
    git(s.main, "worktree", "remove", "--force", s.slot);
    git(s.main, "branch", "-D", s.branch);
    await assert.rejects(sync(s), /no longer exists/);
    assert.ok(readSessionTip(s.session, s.branch));
  });
});

describe("watchForChange", () => {
  test("runs once per burst of changes, shortly after the last one", async () => {
    let value: string | undefined = "a";
    let runs = 0;
    const watcher = watchForChange({ read: () => value, run: async () => void runs++, intervalMs: 10, settleMs: 40 });
    await sleep(80);
    assert.equal(runs, 0);

    value = "b";
    await sleep(15);
    value = "c";
    await sleep(150);
    assert.equal(runs, 1);

    value = "d";
    await sleep(150);
    assert.equal(runs, 2);
    await watcher.stop();
    value = "e";
    await sleep(100);
    assert.equal(runs, 2);
  });

  test("a failing run does not stop the watcher", async () => {
    let value = "a";
    let runs = 0;
    const watcher = watchForChange({
      read: () => value,
      run: async () => {
        runs++;
        throw new Error("docker is down");
      },
      intervalMs: 10,
      settleMs: 20,
    });
    value = "b";
    await sleep(80);
    value = "c";
    await sleep(80);
    await watcher.stop();
    assert.equal(runs, 2);
  });
});
