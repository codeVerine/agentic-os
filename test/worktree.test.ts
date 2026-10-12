import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { AosError } from "../src/errors.ts";
import { aosPaths, locateProject } from "../src/paths.ts";
import { deleteBranch, isMergedInto, isWorktreeClean, mergeLocally } from "../src/git.ts";
import { projectKey, readRegistry, withRegistryLock, type WorktreeRecord } from "../src/registry.ts";
import { detectResumeIntent, extractExplicitSessionId, findWorktreeForSession, mostRecentlyUsed } from "../src/resume.ts";
import { assertTreehouseInstalled } from "../src/treehouse.ts";
import { containerWorkdir } from "../src/worktree.ts";
import { initCommittedRepo } from "./helpers.ts";

describe("detectResumeIntent", () => {
  test("claude: -r/--resume and -c/--continue, not a plain launch", () => {
    assert.equal(detectResumeIntent("claude", ["--resume"]), true);
    assert.equal(detectResumeIntent("claude", ["-r"]), true);
    assert.equal(detectResumeIntent("claude", ["--resume=abc-123"]), true);
    assert.equal(detectResumeIntent("claude", ["--resume", "abc-123"]), true);
    assert.equal(detectResumeIntent("claude", ["-c"]), true);
    assert.equal(detectResumeIntent("claude", ["--continue"]), true);
    assert.equal(detectResumeIntent("claude", ["--model", "opus"]), false);
    assert.equal(detectResumeIntent("claude", []), false);
  });

  test("codex: the resume subcommand only, not exec or other subcommands", () => {
    assert.equal(detectResumeIntent("codex", ["resume"]), true);
    assert.equal(detectResumeIntent("codex", ["resume", "abc-123", "--last"]), true);
    assert.equal(detectResumeIntent("codex", ["exec", "resume"]), false);
    assert.equal(detectResumeIntent("codex", ["--model", "o3"]), false);
  });

  test("opencode: -c/--continue and -s/--session", () => {
    assert.equal(detectResumeIntent("opencode", ["-c"]), true);
    assert.equal(detectResumeIntent("opencode", ["--continue"]), true);
    assert.equal(detectResumeIntent("opencode", ["-s", "abc"]), true);
    assert.equal(detectResumeIntent("opencode", ["--session", "abc"]), true);
    assert.equal(detectResumeIntent("opencode", ["--session=abc"]), true);
    assert.equal(detectResumeIntent("opencode", ["--model", "gpt"]), false);
  });

  test("pi: -c/--continue, -r/--resume, --session and --session-id", () => {
    assert.equal(detectResumeIntent("pi", ["-c"]), true);
    assert.equal(detectResumeIntent("pi", ["-r"]), true);
    assert.equal(detectResumeIntent("pi", ["--resume"]), true);
    assert.equal(detectResumeIntent("pi", ["--session", "abc"]), true);
    assert.equal(detectResumeIntent("pi", ["--session-id", "abc"]), true);
    assert.equal(detectResumeIntent("pi", ["--session=abc"]), true);
    assert.equal(detectResumeIntent("pi", ["--session-id=abc"]), true);
    assert.equal(detectResumeIntent("pi", ["--thinking", "high"]), false);
  });
});

describe("extractExplicitSessionId", () => {
  test("claude: the value of -r/--resume, not when it is bare or followed by another flag", () => {
    assert.equal(extractExplicitSessionId("claude", ["--resume", "abc-123"]), "abc-123");
    assert.equal(extractExplicitSessionId("claude", ["--resume=abc-123"]), "abc-123");
    assert.equal(extractExplicitSessionId("claude", ["-r", "abc-123"]), "abc-123");
    assert.equal(extractExplicitSessionId("claude", ["-r"]), undefined);
    assert.equal(extractExplicitSessionId("claude", ["--resume="]), undefined);
    assert.equal(extractExplicitSessionId("claude", ["--resume"]), undefined);
    assert.equal(extractExplicitSessionId("claude", ["--resume", "--verbose"]), undefined);
    assert.equal(extractExplicitSessionId("claude", ["-c"]), undefined);
  });

  test("codex: the positional session id right after the resume subcommand, not --last", () => {
    assert.equal(extractExplicitSessionId("codex", ["resume", "abc-123"]), "abc-123");
    assert.equal(extractExplicitSessionId("codex", ["resume", "--last"]), undefined);
    assert.equal(extractExplicitSessionId("codex", ["resume"]), undefined);
  });

  test("opencode: the value after -s or --session", () => {
    assert.equal(extractExplicitSessionId("opencode", ["-s", "abc-123"]), "abc-123");
    assert.equal(extractExplicitSessionId("opencode", ["--session", "abc-123"]), "abc-123");
    assert.equal(extractExplicitSessionId("opencode", ["--session=abc-123"]), "abc-123");
    assert.equal(extractExplicitSessionId("opencode", ["-c"]), undefined);
  });

  test("pi: the value after --session or --session-id", () => {
    assert.equal(extractExplicitSessionId("pi", ["--session", "abc-123"]), "abc-123");
    assert.equal(extractExplicitSessionId("pi", ["--session-id", "abc-123"]), "abc-123");
    assert.equal(extractExplicitSessionId("pi", ["--session=abc-123"]), "abc-123");
    assert.equal(extractExplicitSessionId("pi", ["--session-id=abc-123"]), "abc-123");
    assert.equal(extractExplicitSessionId("pi", ["-r"]), undefined);
  });
});

describe("findWorktreeForSession", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "aos-session-lookup-")));
  after(() => rmSync(base, { recursive: true, force: true }));
  const mainSandbox = "repo-feedf00d";

  const record = (agent: "claude" | "codex" | "pi", sandbox: string): WorktreeRecord => ({
    id: sandbox,
    agent,
    branch: `aos/${agent}/${sandbox}`,
    worktreePath: `/tmp/${sandbox}`,
    sandboxName: sandbox,
    baseRev: "abc",
    createdAt: "now",
    lastUsedAt: "now",
    leaseId: "lease",
  });

  test("claude: finds the record whose container path encodes the session's directory", async () => {
    const agentDir = join(base, "claude-agent");
    const sandbox = "repo-deadbeef";
    const projectDir = join(agentDir, "projects", `-home-agent-projects-${sandbox}`);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "session-abc.jsonl"), "{}\n");
    const records = [record("claude", sandbox)];

    const found = await findWorktreeForSession("claude", "session-abc", agentDir, records, mainSandbox);
    assert.equal(found.kind === "worktree" && found.record.sandboxName, sandbox);

    const missing = await findWorktreeForSession("claude", "no-such-session", agentDir, records, mainSandbox);
    assert.equal(missing.kind, "not-found");
  });

  test("claude: a session that ran in the project's own checkout maps to the main checkout, not a worktree", async () => {
    const agentDir = join(base, "claude-main");
    const projectDir = join(agentDir, "projects", `-home-agent-projects-${mainSandbox}`);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "session-here.jsonl"), "{}\n");
    const records = [record("claude", "repo-deadbeef")];

    const found = await findWorktreeForSession("claude", "session-here", agentDir, records, mainSandbox);
    assert.equal(found.kind, "main-checkout");
  });

  test("codex: reads the rollout file's own cwd field instead of a directory name", async () => {
    const agentDir = join(base, "codex-agent");
    const sandbox = "repo-c0ffee42";
    const dayDir = join(agentDir, "sessions", "2026", "09", "29");
    mkdirSync(dayDir, { recursive: true });
    writeFileSync(
      join(dayDir, "rollout-2026-09-29T00-00-00-session-xyz.jsonl"),
      `${JSON.stringify({
        timestamp: "2026-09-29T00:00:00Z",
        type: "session_meta",
        payload: { id: "session-xyz", cwd: `/home/agent/projects/${sandbox}` },
      })}\n`,
    );
    const records = [record("codex", sandbox)];

    const found = await findWorktreeForSession("codex", "session-xyz", agentDir, records, mainSandbox);
    assert.equal(found.kind === "worktree" && found.record.sandboxName, sandbox);
  });

  test("pi: finds the record from a filename ending _<id>.jsonl under its session directory", async () => {
    const agentDir = join(base, "pi-agent");
    const sandbox = "repo-1234abcd";
    const sessionDir = join(agentDir, "sessions", `--home-agent-projects-${sandbox}--`);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, `2026-09-29T00-00-00-000Z_session-pi-1.jsonl`), "{}\n");
    const records = [record("pi", sandbox)];

    const found = await findWorktreeForSession("pi", "session-pi-1", agentDir, records, mainSandbox);
    assert.equal(found.kind === "worktree" && found.record.sandboxName, sandbox);
  });

  test("opencode: reported as unsupported rather than guessed at", async () => {
    const found = await findWorktreeForSession("opencode", "anything", join(base, "opencode-agent"), [], mainSandbox);
    assert.equal(found.kind, "unsupported");
  });
});

describe("assertTreehouseInstalled", () => {
  test("throws naming the install source and the --here escape hatch when the binary is missing", () => {
    assert.throws(
      () => assertTreehouseInstalled("claude", "aos-test-definitely-not-a-real-binary"),
      (error) =>
        error instanceof AosError &&
        error.message.includes("github.com/kunchenguid/treehouse") &&
        error.message.includes("aos claude --here"),
    );
  });
});

describe("mostRecentlyUsed", () => {
  const record = (agent: "claude" | "codex", lastUsedAt: string): WorktreeRecord => ({
    id: lastUsedAt,
    agent,
    branch: `aos/${agent}/${lastUsedAt}`,
    worktreePath: `/tmp/${lastUsedAt}`,
    sandboxName: `x-${lastUsedAt}`,
    baseRev: "abc",
    createdAt: lastUsedAt,
    lastUsedAt,
    leaseId: "lease",
  });

  test("picks the newest record for the given agent, ignoring other agents", () => {
    const records = [record("claude", "2026-01-01T00:00:00Z"), record("codex", "2026-01-03T00:00:00Z"), record("claude", "2026-01-02T00:00:00Z")];
    assert.equal(mostRecentlyUsed(records, "claude")?.id, "2026-01-02T00:00:00Z");
    assert.equal(mostRecentlyUsed(records, "codex")?.id, "2026-01-03T00:00:00Z");
    assert.equal(mostRecentlyUsed(records, "opencode"), undefined);
  });
});

describe("projectKey and the registry", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "aos-worktree-")));
  after(() => rmSync(base, { recursive: true, force: true }));

  function repo(name: string): string {
    return initCommittedRepo(join(base, name));
  }

  test("is the same from the main checkout and a linked worktree, different across repos", () => {
    const main = repo("proj-a");
    const worktree = join(base, "proj-a-wt");
    execFileSync("git", ["-C", main, "worktree", "add", "--quiet", "-b", "feature", worktree]);
    const other = repo("proj-b");
    assert.equal(projectKey(main), projectKey(worktree));
    assert.notEqual(projectKey(main), projectKey(other));
  });

  test("readRegistry returns an empty array when no file exists yet, and rejects invalid JSON", () => {
    const paths = aosPaths(join(base, "aos-root-empty"));
    assert.deepEqual(readRegistry(paths, "missing-key"), []);

    const paths2 = aosPaths(join(base, "aos-root-bad"));
    mkdirSync(paths2.worktrees, { recursive: true });
    writeFileSync(join(paths2.worktrees, "bad.json"), "{not json", "utf8");
    assert.throws(() => readRegistry(paths2, "bad"), (error) => error instanceof AosError && /not valid JSON/.test(error.message));
  });

  test("withRegistryLock persists writes across separate calls and serializes concurrent updates", async () => {
    const paths = aosPaths(join(base, "aos-root-lock"));
    const key = "proj";
    const seed = (id: string): WorktreeRecord => ({
      id,
      agent: "claude",
      branch: `aos/claude/${id}`,
      worktreePath: `/tmp/${id}`,
      sandboxName: `x-${id}`,
      baseRev: "abc",
      createdAt: "now",
      lastUsedAt: "now",
      leaseId: "lease",
    });

    await Promise.all(
      ["a", "b", "c", "d"].map((id) => withRegistryLock(paths, key, (records) => ({ records: [...records, seed(id)], value: undefined }))),
    );

    const records = readRegistry(paths, key);
    assert.equal(records.length, 4);
    assert.deepEqual(
      records.map((r) => r.id).sort(),
      ["a", "b", "c", "d"],
    );
  });
});

describe("git-backed safety checks", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "aos-worktree-git-")));
  after(() => rmSync(base, { recursive: true, force: true }));

  function setup(name: string): { main: string; worktree: string; branch: string } {
    const main = initCommittedRepo(join(base, name));
    const branch = `aos/claude/${name}`;
    const worktree = join(base, `${name}-wt`);
    execFileSync("git", ["-C", main, "worktree", "add", "--quiet", "-b", branch, worktree]);
    return { main, worktree, branch };
  }

  test("isWorktreeClean reflects uncommitted changes", () => {
    const { worktree } = setup("clean-check");
    assert.equal(isWorktreeClean(worktree), true);
    writeFileSync(join(worktree, "file.txt"), "hi");
    assert.equal(isWorktreeClean(worktree), false);
  });

  test("isMergedInto is false until the branch's commits reach the main checkout's HEAD", () => {
    const { main, worktree, branch } = setup("merge-check");
    writeFileSync(join(worktree, "file.txt"), "hi");
    execFileSync("git", ["-C", worktree, "add", "file.txt"]);
    execFileSync("git", ["-C", worktree, "commit", "--quiet", "-m", "change"]);
    assert.equal(isMergedInto(main, branch), false);
    mergeLocally(main, branch);
    assert.equal(isMergedInto(main, branch), true);
  });

  test("mergeLocally throws an AosError on conflict instead of leaving a half-done merge silently", () => {
    const { main, worktree, branch } = setup("conflict-check");
    writeFileSync(join(main, "file.txt"), "main version");
    execFileSync("git", ["-C", main, "add", "file.txt"]);
    execFileSync("git", ["-C", main, "commit", "--quiet", "-m", "main change"]);
    writeFileSync(join(worktree, "file.txt"), "worktree version");
    execFileSync("git", ["-C", worktree, "add", "file.txt"]);
    execFileSync("git", ["-C", worktree, "commit", "--quiet", "-m", "worktree change"]);
    assert.throws(() => mergeLocally(main, branch), AosError);
    execFileSync("git", ["-C", main, "merge", "--abort"]);
  });

  test("deleteBranch refuses an unmerged branch without force, and -D removes it with force", () => {
    const { main, worktree, branch } = setup("delete-check");
    writeFileSync(join(worktree, "file.txt"), "hi");
    execFileSync("git", ["-C", worktree, "add", "file.txt"]);
    execFileSync("git", ["-C", worktree, "commit", "--quiet", "-m", "change"]);
    execFileSync("git", ["-C", main, "worktree", "remove", "--force", worktree]);
    assert.throws(() => deleteBranch(main, branch, false), AosError);
    deleteBranch(main, branch, true);
    const branches = execFileSync("git", ["-C", main, "branch", "--list", branch], { encoding: "utf8" });
    assert.equal(branches.trim(), "");
  });
});

describe("locateProject on an aos-style worktree", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "aos-worktree-locate-")));
  after(() => rmSync(base, { recursive: true, force: true }));

  test("a freshly leased-and-branched worktree resolves like any other linked worktree", () => {
    const main = join(base, "repo");
    mkdirSync(main);
    execFileSync("git", ["init", "--quiet", main]);
    execFileSync("git", ["-C", main, "commit", "--quiet", "--allow-empty", "-m", "init"]);
    const worktree = join(base, "repo-leased");
    execFileSync("git", ["-C", main, "worktree", "add", "--quiet", "--detach", worktree]);
    execFileSync("git", ["-C", worktree, "checkout", "-q", "-b", "aos/claude/test-id"]);
    const project = locateProject(worktree);
    assert.equal(project.root, worktree);
    assert.equal(project.subdir, "");
  });
});

describe("containerWorkdir", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "aos-worktree-workdir-")));
  after(() => rmSync(base, { recursive: true, force: true }));

  test("keeps the launch subdirectory when it exists in the mounted checkout", () => {
    mkdirSync(join(base, "src", "lib"), { recursive: true });
    assert.equal(containerWorkdir("/home/agent/projects/p", base, "src/lib"), "/home/agent/projects/p/src/lib");
  });

  test("falls back to the checkout root when the subdirectory is missing from the worktree", () => {
    assert.equal(containerWorkdir("/home/agent/projects/p", base, "scratch"), "/home/agent/projects/p");
  });

  test("uses the checkout root for a launch from the repository root", () => {
    assert.equal(containerWorkdir("/home/agent/projects/p", base, ""), "/home/agent/projects/p");
  });
});
