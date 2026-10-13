import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createVerify, generateKeyPairSync, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { AosError } from "../src/errors.ts";
import {
  classifyRemote,
  githubSetup,
  mintInstallationToken,
  parseRepoPath,
  prepareGithubAccess,
  tokenForRepo,
  type GithubAppConfig,
} from "../src/github.ts";
import { parseSecretsEnv } from "../src/secrets.ts";
import { initRepo } from "./helpers.ts";

const HELPER = fileURLToPath(new URL("../docker/aos-github.mjs", import.meta.url));
const APP_ID = "123456";
const HOUR_MS = 60 * 60 * 1000;

const base = mkdtempSync(join(tmpdir(), "aos-github-"));
after(() => rmSync(base, { recursive: true, force: true }));

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const keyFile = join(base, "app.pem");
writeFileSync(keyFile, keyPem, { mode: 0o600 });
const config: GithubAppConfig = { appId: APP_ID, keyFile };
const secrets = parseSecretsEnv(`AOS_GITHUB_APP_ID=${APP_ID}\nAOS_GITHUB_APP_KEY_FILE=${keyFile}\n`);

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly jwt: { readonly iss: unknown; readonly iat: number; readonly exp: number; readonly valid: boolean };
}

interface FakeGithub {
  readonly url: string;
  readonly calls: Call[];
  mints(): number;
  clock: { now: number };
  tokenLifetimeMs: number;
  close(): Promise<void>;
}

function decodeJwt(header: string | undefined, key: KeyObject): Call["jwt"] {
  const token = (header ?? "").replace(/^Bearer /, "");
  const [head, payload, signature] = token.split(".");
  const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")) as { iss: unknown; iat: number; exp: number };
  const valid = createVerify("RSA-SHA256")
    .update(`${head}.${payload}`)
    .verify(key, Buffer.from(signature ?? "", "base64url"));
  return { ...claims, valid };
}

async function body(request: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text === "" ? undefined : JSON.parse(text);
}

async function startFakeGithub(): Promise<FakeGithub> {
  const calls: Call[] = [];
  const fake: FakeGithub = {
    url: "",
    calls,
    mints: () => calls.filter((call) => call.method === "POST").length,
    clock: { now: Date.now() },
    tokenLifetimeMs: HOUR_MS,
    close: async () => {},
  };
  const server: Server = createServer(async (request, response) => {
    const path = request.url ?? "";
    const call: Call = {
      method: request.method ?? "",
      path,
      body: await body(request),
      jwt: decodeJwt(request.headers.authorization, publicKey),
    };
    calls.push(call);
    const send = (status: number, payload: unknown): void => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    if (!call.jwt.valid) return send(401, { message: "bad credentials" });
    if (call.method === "GET" && /^\/repos\/[^/]+\/missing\/installation$/.test(path)) return send(404, { message: "Not Found" });
    if (call.method === "GET" && /^\/repos\/[^/]+\/[^/]+\/installation$/.test(path)) return send(200, { id: 4242 });
    if (call.method === "POST" && path === "/app/installations/4242/access_tokens") {
      const sequence = fake.mints();
      return send(201, {
        token: `ghs_token${sequence}`,
        expires_at: new Date(fake.clock.now + fake.tokenLifetimeMs).toISOString(),
      });
    }
    return send(404, { message: "unexpected request" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  fake.close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return Object.assign(fake, { url: `http://127.0.0.1:${address.port}` });
}

interface HelperResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runHelper(args: readonly string[], env: Record<string, string>, stdin = "", cwd = base): Promise<HelperResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HELPER, ...args], { cwd, env: { PATH: process.env.PATH ?? "", ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

function gitRepo(name: string, origin?: string): string {
  const dir = initRepo(join(base, name));
  if (origin) execFileSync("git", ["-C", dir, "remote", "add", "origin", origin]);
  return dir;
}

let launches = 0;
function session(fake: FakeGithub, repoRoot: string, tokensDir: string, notify?: (message: string) => void) {
  const spool = mkdtempSync(join(base, `spool-${launches++}-`));
  const access = prepareGithubAccess({
    secrets,
    repoRoot,
    pinFile: join(base, "pins", `${basename(repoRoot)}.json`),
    spoolDir: spool,
    containerSpoolDir: "/mnt/aos-launch/run/github",
    tokensDir,
    api: { baseUrl: fake.url, now: () => fake.clock.now },
    notify,
  });
  return { access, spool };
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`no answer written to ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const credentialInput = (path: string, host = "github.com"): string => `protocol=https\nhost=${host}\npath=${path}\n\n`;

describe("mintInstallationToken", () => {
  let fake: FakeGithub;
  before(async () => {
    fake = await startFakeGithub();
  });
  after(() => fake.close());

  test("signs an App JWT and narrows the token to one repository with contents and pull request write", async () => {
    const minted = await mintInstallationToken(config, { owner: "acme", name: "widgets" }, { baseUrl: fake.url, now: () => fake.clock.now });
    assert.match(minted.token, /^ghs_token/);
    assert.equal(minted.expiresAt, fake.clock.now + HOUR_MS);

    const [lookup, mint] = fake.calls;
    assert.equal(lookup?.path, "/repos/acme/widgets/installation");
    assert.equal(mint?.path, "/app/installations/4242/access_tokens");
    assert.deepEqual(mint?.body, { repositories: ["widgets"], permissions: { contents: "write", pull_requests: "write" } });
    for (const call of [lookup, mint]) {
      assert.equal(call?.jwt.valid, true);
      assert.equal(call?.jwt.iss, APP_ID);
      assert.ok((call?.jwt.exp ?? 0) - (call?.jwt.iat ?? 0) <= 10 * 60);
    }
  });

  test("explains when the App is not installed on the repository", async () => {
    await assert.rejects(
      mintInstallationToken(config, { owner: "acme", name: "missing" }, { baseUrl: fake.url }),
      (error: unknown) => error instanceof AosError && /not installed on acme\/missing/.test(error.message),
    );
  });
});

describe("tokenForRepo", () => {
  let fake: FakeGithub;
  before(async () => {
    fake = await startFakeGithub();
  });
  after(() => fake.close());

  const repo = { owner: "acme", name: "widgets" };
  const api = () => ({ baseUrl: fake.url, now: () => fake.clock.now });

  test("parallel callers share one minted token", async () => {
    const tokensDir = join(base, "tokens-shared");
    const mintsBefore = fake.mints();
    const tokens = await Promise.all([1, 2, 3, 4].map(() => tokenForRepo(config, repo, tokensDir, api())));
    assert.equal(new Set(tokens).size, 1);
    assert.equal(fake.mints() - mintsBefore, 1);
  });

  test("keeps a token until five minutes remain, then mints a new one", async () => {
    const tokensDir = join(base, "tokens-refresh");
    fake.clock.now = Date.now();
    const first = await tokenForRepo(config, repo, tokensDir, api());

    fake.clock.now += 30 * 60 * 1000;
    assert.equal(await tokenForRepo(config, repo, tokensDir, api()), first);

    fake.clock.now += 26 * 60 * 1000;
    const second = await tokenForRepo(config, repo, tokensDir, api());
    assert.notEqual(second, first);
    assert.equal(await tokenForRepo(config, repo, tokensDir, api()), second);
  });

  test("tracks repositories separately", async () => {
    const tokensDir = join(base, "tokens-separate");
    const a = await tokenForRepo(config, repo, tokensDir, api());
    const b = await tokenForRepo(config, { owner: "acme", name: "gadgets" }, tokensDir, api());
    assert.notEqual(a, b);
  });
});

describe("container credential helper", () => {
  let fake: FakeGithub;
  before(async () => {
    fake = await startFakeGithub();
  });
  after(() => fake.close());

  const origin = "https://github.com/acme/widgets.git";

  test("git credential get returns the repository token", async () => {
    const { access, spool } = session(fake, gitRepo("cred-repo", origin), join(base, "tokens-cred"));
    try {
      const result = await runHelper(["credential", "get"], { AOS_GITHUB_SPOOL: spool }, credentialInput("acme/widgets.git"));
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /^username=x-access-token\npassword=ghs_token\d+\n$/);
      assert.equal(readdirSync(spool).length, 0, "request and response files are cleaned up");
    } finally {
      access.stop();
    }
  });

  test("parallel sessions of one repository get the same token from one mint", async () => {
    const tokensDir = join(base, "tokens-parallel");
    const repoRoot = gitRepo("parallel-repo", origin);
    const sessions = [session(fake, repoRoot, tokensDir), session(fake, repoRoot, tokensDir), session(fake, repoRoot, tokensDir)];
    const mintsBefore = fake.mints();
    try {
      const results = await Promise.all(
        sessions.map(({ spool }) => runHelper(["credential", "get"], { AOS_GITHUB_SPOOL: spool }, credentialInput("acme/widgets.git"))),
      );
      assert.equal(new Set(results.map((result) => result.stdout)).size, 1);
      assert.match(results[0]?.stdout ?? "", /password=ghs_token/);
      assert.equal(fake.mints() - mintsBefore, 1);
    } finally {
      for (const { access } of sessions) access.stop();
    }
  });

  test("gh token prints the token for the origin repository", async () => {
    const repoRoot = gitRepo("gh-repo", origin);
    const { access, spool } = session(fake, repoRoot, join(base, "tokens-gh"));
    try {
      const result = await runHelper(["token"], { AOS_GITHUB_SPOOL: spool }, "", repoRoot);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /^ghs_token\d+\n$/);
    } finally {
      access.stop();
    }
  });

  test("refuses another repository and another host, and never mints for them", async () => {
    const { access, spool } = session(fake, gitRepo("refuse-repo", origin), join(base, "tokens-refuse"));
    const mintsBefore = fake.mints();
    try {
      const other = await runHelper(["credential", "get"], { AOS_GITHUB_SPOOL: spool }, credentialInput("acme/secrets.git"));
      assert.equal(other.stdout, "");
      assert.match(other.stderr, /acme\/widgets only, not acme\/secrets/);

      const gitlab = await runHelper(["credential", "get"], { AOS_GITHUB_SPOOL: spool }, credentialInput("acme/widgets.git", "gitlab.com"));
      assert.equal(gitlab.stdout, "");
      assert.equal(fake.mints(), mintsBefore);
    } finally {
      access.stop();
    }
  });

  test("an App that is not installed produces a message and no credential", async () => {
    const missing = gitRepo("missing-repo", "https://github.com/acme/missing.git");
    const notes: string[] = [];
    const { access, spool } = session(fake, missing, join(base, "tokens-missing"), (note) => notes.push(note));
    try {
      const result = await runHelper(["credential", "get"], { AOS_GITHUB_SPOOL: spool }, credentialInput("acme/missing.git"));
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /could not get a GitHub token for acme\/missing/);
      assert.ok(notes.some((note) => /not installed on acme\/missing/.test(note)));
    } finally {
      access.stop();
    }
  });

  test("without GitHub access configured the helper says how to set it up", async () => {
    const result = await runHelper(["credential", "get"], { AOS_GITHUB_STATUS: "GitHub access is not configured, set it up" }, credentialInput("acme/widgets.git"));
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /not configured/);

    const token = await runHelper(["token"], { AOS_GITHUB_STATUS: "GitHub access is not configured, set it up" });
    assert.equal(token.code, 1);
  });
});

describe("prepareGithubAccess", () => {
  let fake: FakeGithub;
  before(async () => {
    fake = await startFakeGithub();
  });
  after(() => fake.close());

  test("hands the container only a spool path, never the key", () => {
    const { access, spool } = session(fake, gitRepo("env-repo", "https://github.com/acme/widgets.git"), join(base, "tokens-env"));
    try {
      assert.deepEqual(Object.keys(access.env), ["AOS_GITHUB_SPOOL"]);
      assert.equal(access.env.AOS_GITHUB_SPOOL, "/mnt/aos-launch/run/github");
      assert.ok(existsSync(spool));
      const everything = JSON.stringify(access.env);
      assert.ok(!everything.includes(keyFile));
      assert.ok(!everything.includes("PRIVATE KEY"));
      assert.ok(!everything.includes(APP_ID));
    } finally {
      access.stop();
    }
  });

  test("an SSH origin gets a set-url message instead of access", () => {
    const notes: string[] = [];
    const { access } = session(fake, gitRepo("ssh-repo", "git@github.com:acme/widgets.git"), join(base, "tokens-ssh"), (note) => notes.push(note));
    assert.deepEqual(Object.keys(access.env), ["AOS_GITHUB_STATUS"]);
    assert.match(access.env.AOS_GITHUB_STATUS ?? "", /git remote set-url origin https:\/\/github\.com\/acme\/widgets\.git/);
    assert.equal(notes.length, 1);
  });

  test("a request file that links to a host file is refused without reading the file", async () => {
    const victim = join(base, "victim-read");
    writeFileSync(victim, "HOST-SECRET");
    const { access, spool } = session(fake, gitRepo("symlink-req", "https://github.com/acme/widgets.git"), join(base, "tokens-symlink-req"));
    const id = "a".repeat(32);
    try {
      symlinkSync(victim, join(spool, `${id}.req`));
      await waitForFile(join(spool, `${id}.res`));
      const response = readFileSync(join(spool, `${id}.res`), "utf8");
      assert.equal(JSON.parse(response).ok, false);
      assert.ok(!response.includes("HOST-SECRET"));
      assert.equal(readFileSync(victim, "utf8"), "HOST-SECRET");
    } finally {
      access.stop();
    }
  });

  test("a request directory is answered and removed, not retried forever", async () => {
    const { access, spool } = session(fake, gitRepo("dir-req", "https://github.com/acme/widgets.git"), join(base, "tokens-dir-req"));
    const id = "e".repeat(32);
    try {
      mkdirSync(join(spool, `${id}.req`));
      await waitForFile(join(spool, `${id}.res`));
      assert.equal(JSON.parse(readFileSync(join(spool, `${id}.res`), "utf8")).ok, false);
      assert.equal(existsSync(join(spool, `${id}.req`)), false);
    } finally {
      access.stop();
    }
  });

  test("an oversized request is refused rather than read whole", async () => {
    const { access, spool } = session(fake, gitRepo("oversize-req", "https://github.com/acme/widgets.git"), join(base, "tokens-oversize-req"));
    const id = "f".repeat(32);
    try {
      writeFileSync(join(spool, `${id}.req`), JSON.stringify({ host: "github.com", path: "acme/widgets.git", pad: "x".repeat(1024 * 1024) }));
      await waitForFile(join(spool, `${id}.res`));
      assert.equal(JSON.parse(readFileSync(join(spool, `${id}.res`), "utf8")).ok, false);
    } finally {
      access.stop();
    }
  });

  test("a staging directory is replaced, so the answer still lands", async () => {
    const { access, spool } = session(fake, gitRepo("dir-res", "https://github.com/acme/widgets.git"), join(base, "tokens-dir-res"));
    const id = "0".repeat(32);
    try {
      mkdirSync(join(spool, `${id}.res.tmp`));
      writeFileSync(join(spool, `${id}.req`), JSON.stringify({ host: "github.com", path: "acme/widgets.git" }));
      await waitForFile(join(spool, `${id}.res`));
      assert.equal(JSON.parse(readFileSync(join(spool, `${id}.res`), "utf8")).ok, true);
    } finally {
      access.stop();
    }
  });

  test("a failed token mint tells the container nothing about host paths", async () => {
    const key = join(base, "vanishing.pem");
    writeFileSync(key, keyPem, { mode: 0o600 });
    const spool = mkdtempSync(join(base, "spool-vanishing-"));
    const access = prepareGithubAccess({
      secrets: parseSecretsEnv(`AOS_GITHUB_APP_ID=${APP_ID}\nAOS_GITHUB_APP_KEY_FILE=${key}\n`),
      repoRoot: gitRepo("vanishing-key", "https://github.com/acme/widgets.git"),
      pinFile: join(base, "pins", "vanishing-key.json"),
      spoolDir: spool,
      containerSpoolDir: "/mnt/aos-launch/run/github",
      tokensDir: join(base, "tokens-vanishing"),
      api: { baseUrl: fake.url, now: () => fake.clock.now },
    });
    const id = "1".repeat(32);
    try {
      rmSync(key);
      writeFileSync(join(spool, `${id}.req`), JSON.stringify({ host: "github.com", path: "acme/widgets.git" }));
      await waitForFile(join(spool, `${id}.res`));
      const response = readFileSync(join(spool, `${id}.res`), "utf8");
      assert.equal(JSON.parse(response).ok, false);
      assert.ok(!response.includes(base));
    } finally {
      access.stop();
    }
  });

  test("a staging entry that links to a host file is replaced, never written through", async () => {
    const victim = join(base, "victim-write");
    writeFileSync(victim, "HOST-KEEP");
    const { access, spool } = session(fake, gitRepo("symlink-res", "https://github.com/acme/widgets.git"), join(base, "tokens-symlink-res"));
    const id = "b".repeat(32);
    try {
      symlinkSync(victim, join(spool, `${id}.res.tmp`));
      writeFileSync(join(spool, `${id}.req`), JSON.stringify({ host: "github.com", path: "acme/widgets.git" }));
      await waitForFile(join(spool, `${id}.res`));
      assert.ok(lstatSync(join(spool, `${id}.res`)).isFile());
      assert.equal(JSON.parse(readFileSync(join(spool, `${id}.res`), "utf8")).ok, true);
      assert.equal(readFileSync(victim, "utf8"), "HOST-KEEP");
    } finally {
      access.stop();
    }
  });

  test("a project without a GitHub origin gets a status message", () => {
    const { access } = session(fake, gitRepo("no-origin"), join(base, "tokens-none"));
    assert.match(access.env.AOS_GITHUB_STATUS ?? "", /no origin remote/);
    const { access: other } = session(fake, gitRepo("gitlab-origin", "https://gitlab.com/acme/widgets.git"), join(base, "tokens-none"));
    assert.match(other.env.AOS_GITHUB_STATUS ?? "", /not an https:\/\/github\.com remote/);
  });

  test("an unconfigured aos keeps containers without credentials and says why", () => {
    const spool = join(base, "spool-unconfigured");
    mkdirSync(spool);
    const access = prepareGithubAccess({
      secrets: parseSecretsEnv(""),
      repoRoot: gitRepo("unconfigured-repo", "https://github.com/acme/widgets.git"),
      pinFile: join(base, "pins", "unconfigured-repo.json"),
      spoolDir: spool,
      containerSpoolDir: "/mnt/aos-launch/run/github",
      tokensDir: join(base, "tokens-unconfigured"),
    });
    assert.match(access.env.AOS_GITHUB_STATUS ?? "", /AOS_GITHUB_APP_ID/);
    assert.equal(readdirSync(spool).length, 0);
  });

  test("a misconfigured key keeps host paths out of the container env but tells the host", () => {
    const missingKey = join(base, "missing-key-dir", "app.pem");
    const notes: string[] = [];
    const access = prepareGithubAccess({
      secrets: parseSecretsEnv(`AOS_GITHUB_APP_ID=${APP_ID}\nAOS_GITHUB_APP_KEY_FILE=${missingKey}\n`),
      repoRoot: gitRepo("misconfigured-key", "https://github.com/acme/widgets.git"),
      pinFile: join(base, "pins", "misconfigured-key.json"),
      spoolDir: join(base, "spool-misconfigured"),
      containerSpoolDir: "/mnt/aos-launch/run/github",
      tokensDir: join(base, "tokens-misconfigured"),
      notify: (note) => notes.push(note),
    });
    assert.ok(!(access.env.AOS_GITHUB_STATUS ?? "").includes(base));
    assert.match(access.env.AOS_GITHUB_STATUS ?? "", /misconfigured/);
    assert.equal(notes.length, 1);
    assert.match(notes[0] ?? "", /does not exist/);
    assert.ok(notes[0]?.includes(missingKey));
  });
});

describe("repository pin", () => {
  let fake: FakeGithub;
  before(async () => {
    fake = await startFakeGithub();
  });
  after(() => fake.close());

  const setOrigin = (repo: string, url: string): void => {
    execFileSync("git", ["-C", repo, "remote", "set-url", "origin", url]);
  };

  test("the first launch pins the repository and a later retarget of origin gets no token", () => {
    const repo = gitRepo("pin-retarget", "https://github.com/acme/widgets.git");
    const notes: string[] = [];
    const first = session(fake, repo, join(base, "tokens-pin"), (note) => notes.push(note));
    first.access.stop();
    assert.equal(first.access.env.AOS_GITHUB_STATUS, undefined);
    assert.match(readFileSync(join(base, "pins", "pin-retarget.json"), "utf8"), /"owner":"acme","name":"widgets"/);

    setOrigin(repo, "https://github.com/acme/other-private-repo.git");
    const second = session(fake, repo, join(base, "tokens-pin"), (note) => notes.push(note));
    assert.equal(second.access.env.AOS_GITHUB_SPOOL, undefined);
    assert.match(second.access.env.AOS_GITHUB_STATUS ?? "", /pinned to acme\/widgets.*names acme\/other-private-repo/);
    assert.equal(notes.length, 1);
    assert.ok(notes[0]?.includes(join(base, "pins", "pin-retarget.json")));
    assert.ok(!(second.access.env.AOS_GITHUB_STATUS ?? "").includes(base));
    assert.equal(readdirSync(second.spool).length, 0);
  });

  test("the pin matches case-insensitively, so a renamed-case origin keeps working", () => {
    const repo = gitRepo("pin-case", "https://github.com/Acme/Widgets.git");
    session(fake, repo, join(base, "tokens-pin-case")).access.stop();
    setOrigin(repo, "https://github.com/acme/widgets");
    const again = session(fake, repo, join(base, "tokens-pin-case"));
    assert.ok(again.access.env.AOS_GITHUB_SPOOL);
    again.access.stop();
  });

  test("deleting the pin file accepts the repository origin names now", () => {
    const repo = gitRepo("pin-reset", "https://github.com/acme/widgets.git");
    session(fake, repo, join(base, "tokens-pin-reset")).access.stop();
    setOrigin(repo, "https://github.com/acme/moved.git");
    assert.match(session(fake, repo, join(base, "tokens-pin-reset")).access.env.AOS_GITHUB_STATUS ?? "", /pinned to/);
    rmSync(join(base, "pins", "pin-reset.json"));
    const accepted = session(fake, repo, join(base, "tokens-pin-reset"));
    assert.ok(accepted.access.env.AOS_GITHUB_SPOOL);
    accepted.access.stop();
  });

  test("an unreadable pin file is never replaced silently", () => {
    const repo = gitRepo("pin-corrupt", "https://github.com/acme/widgets.git");
    mkdirSync(join(base, "pins"), { recursive: true });
    writeFileSync(join(base, "pins", "pin-corrupt.json"), "{not json");
    const launched = session(fake, repo, join(base, "tokens-pin-corrupt"));
    assert.match(launched.access.env.AOS_GITHUB_STATUS ?? "", /repository pin is unreadable/);
    assert.equal(readFileSync(join(base, "pins", "pin-corrupt.json"), "utf8"), "{not json");
  });

  test("an ssh origin is not pinned, so fixing it to https pins the fixed value", () => {
    const repo = gitRepo("pin-ssh", "git@github.com:acme/widgets.git");
    session(fake, repo, join(base, "tokens-pin-ssh"));
    assert.equal(existsSync(join(base, "pins", "pin-ssh.json")), false);
  });
});

describe("githubSetup", () => {
  test("is unconfigured without either key", () => {
    assert.deepEqual(githubSetup(parseSecretsEnv("OPENAI_API_KEY=x")), { state: "unconfigured" });
  });

  test("is ready with an id and a private key file", () => {
    assert.deepEqual(githubSetup(secrets), { state: "ready", config });
  });

  test("reports a half-set configuration", () => {
    const setup = githubSetup(parseSecretsEnv(`AOS_GITHUB_APP_ID=${APP_ID}`));
    assert.equal(setup.state, "invalid");
    assert.match(setup.state === "invalid" ? setup.problem : "", /AOS_GITHUB_APP_KEY_FILE is not set/);
  });

  test("reports a missing, group-readable or non-PEM key file", () => {
    const setupFor = (file: string) => githubSetup(parseSecretsEnv(`AOS_GITHUB_APP_ID=${APP_ID}\nAOS_GITHUB_APP_KEY_FILE=${file}`));
    const problem = (file: string): string => {
      const setup = setupFor(file);
      return setup.state === "invalid" ? setup.problem : "";
    };
    assert.match(problem(join(base, "nope.pem")), /does not exist/);

    const open = join(base, "open.pem");
    writeFileSync(open, keyPem);
    chmodSync(open, 0o644);
    assert.match(problem(open), /readable by other users/);

    const junk = join(base, "junk.pem");
    writeFileSync(junk, "not a key", { mode: 0o600 });
    assert.match(problem(junk), /not a PEM private key/);
  });

  test("expands ~ in the key path", () => {
    const home = join(base, "home");
    mkdirSync(home);
    writeFileSync(join(home, "app.pem"), keyPem, { mode: 0o600 });
    const setup = githubSetup(parseSecretsEnv(`AOS_GITHUB_APP_ID=${APP_ID}\nAOS_GITHUB_APP_KEY_FILE=~/app.pem`), home);
    assert.deepEqual(setup, { state: "ready", config: { appId: APP_ID, keyFile: join(home, "app.pem") } });
  });
});

describe("remote parsing", () => {
  test("accepts github.com HTTPS remotes", () => {
    for (const url of [
      "https://github.com/acme/widgets.git",
      "https://github.com/acme/widgets",
      "https://github.com/acme/widgets/",
      "https://user@github.com/acme/widgets.git",
      "HTTPS://GitHub.com/acme/widgets.git",
    ]) {
      assert.deepEqual(classifyRemote(url), { kind: "https", repo: { owner: "acme", name: "widgets" } }, url);
    }
  });

  test("recognises SSH remotes and ignores other hosts", () => {
    for (const url of ["git@github.com:acme/widgets.git", "ssh://git@github.com/acme/widgets.git"]) {
      assert.deepEqual(classifyRemote(url), { kind: "ssh", repo: { owner: "acme", name: "widgets" } }, url);
    }
    for (const url of ["https://gitlab.com/acme/widgets.git", "https://github.com.evil.example/acme/widgets.git", "/srv/git/widgets", "https://github.com/acme", "https://github.com/acme/../x"]) {
      assert.deepEqual(classifyRemote(url), { kind: "other" }, url);
    }
  });

  test("parses the path git passes to a credential helper", () => {
    assert.deepEqual(parseRepoPath("acme/widgets.git"), { owner: "acme", name: "widgets" });
    assert.deepEqual(parseRepoPath("/acme/widgets"), { owner: "acme", name: "widgets" });
    assert.equal(parseRepoPath("acme"), undefined);
    assert.equal(parseRepoPath("acme/../etc"), undefined);
    assert.equal(parseRepoPath("a/b/c"), undefined);
  });
});
