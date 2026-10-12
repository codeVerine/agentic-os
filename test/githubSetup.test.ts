import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { AosError } from "../src/errors.ts";
import { appManifest, setupGithubApp } from "../src/githubSetup.ts";
import { aosPaths } from "../src/paths.ts";
import { ensurePrivateDir } from "../src/fsutil.ts";
import { setTopLevelKeys } from "../src/secrets.ts";
import { fileMode } from "./helpers.ts";

const base = mkdtempSync(join(tmpdir(), "aos-github-setup-"));
after(() => rmSync(base, { recursive: true, force: true }));

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const CLIENT_SECRET = "client-secret-must-not-be-printed";
const WEBHOOK_SECRET = "webhook-secret-must-not-be-stored";
const APP_ID = 987654;

interface FakeGithub {
  readonly url: string;
  readonly conversions: string[];
  installations: Array<{ account: { login: string }; repository_selection: string }>;
  failConversion: boolean;
  close(): Promise<void>;
}

async function startFakeGithub(): Promise<FakeGithub> {
  const fake: FakeGithub = { url: "", conversions: [], installations: [], failConversion: false, close: async () => {} };
  const server = createServer((request, response) => {
    const send = (status: number, payload: unknown): void => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    const path = request.url ?? "";
    const conversion = /^\/app-manifests\/([^/]+)\/conversions$/.exec(path);
    if (request.method === "POST" && conversion) {
      fake.conversions.push(decodeURIComponent(conversion[1] ?? ""));
      if (fake.failConversion) return send(404, { message: "Not Found" });
      return send(201, {
        id: APP_ID,
        slug: "aos-octo-test",
        client_secret: CLIENT_SECRET,
        webhook_secret: WEBHOOK_SECRET,
        pem: PEM,
      });
    }
    if (request.method === "GET" && path.startsWith("/app/installations")) {
      const [head, payload, signature] = (request.headers.authorization ?? "").replace(/^Bearer /, "").split(".");
      const valid = createVerify("RSA-SHA256")
        .update(`${head}.${payload}`)
        .verify(publicKey, Buffer.from(signature ?? "", "base64url"));
      const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")) as { iss?: unknown };
      if (!valid || claims.iss !== String(APP_ID)) return send(401, { message: "bad credentials" });
      return send(200, fake.installations);
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

const unescapeHtml = (text: string): string =>
  text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

interface Submitted {
  readonly action: string;
  readonly manifest: ReturnType<typeof appManifest>;
}

/** Reads the page aos serves the way a browser would: finds the form GitHub would receive. */
async function readManifestPage(startUrl: string): Promise<Submitted> {
  const html = await (await fetch(startUrl)).text();
  const action = /<form[^>]*action="([^"]*)"[^>]*method="post"/.exec(html)?.[1];
  const manifest = /<input type="hidden" name="manifest" value="([^"]*)"/.exec(html)?.[1];
  assert.ok(action !== undefined && manifest !== undefined, "the page posts a manifest");
  return { action: unescapeHtml(action), manifest: JSON.parse(unescapeHtml(manifest)) };
}

let roots = 0;
function freshRoot(env = "OPENAI_API_KEY=sk-existing\n\n[pi]\nMY_KEY=pi-only\n") {
  const paths = aosPaths(join(base, `root-${roots++}`));
  ensurePrivateDir(paths.secrets);
  writeFileSync(paths.secretsEnv, env, { mode: 0o600 });
  return { paths, keyFile: join(paths.secrets, "github-app.pem") };
}

describe("aos github setup", () => {
  test("creates the App through the manifest flow and wires up aos", async () => {
    const fake = await startFakeGithub();
    const { paths, keyFile } = freshRoot();
    const lines: string[] = [];
    const opened: string[] = [];
    let browser: Promise<void> = Promise.resolve();
    let submitted: Submitted | undefined;
    let wrongStateStatus = 0;

    fake.installations = [{ account: { login: "octo" }, repository_selection: "all" }];
    try {
      const code = await setupGithubApp({
        paths,
        force: false,
        hostEnv: {},
        githubUrl: fake.url,
        apiUrl: fake.url,
        out: (line) => lines.push(line),
        lookupLogin: () => "octo",
        installPollMs: 20,
        installTimeoutMs: 2000,
        openUrl: (url) => {
          opened.push(url);
          if (opened.length > 1) return;
          browser = (async () => {
            submitted = await readManifestPage(url);
            const redirect = new URL(submitted.manifest.redirect_url);
            const state = new URL(submitted.action).searchParams.get("state") ?? "";
            wrongStateStatus = (await fetch(`${redirect.href}?code=stolen&state=${"0".repeat(state.length)}`)).status;
            await fetch(`${redirect.href}?code=the-manifest-code&state=${state}`);
          })();
        },
      });
      await browser;

      assert.equal(code, 0, lines.join("\n"));
      assert.ok(submitted);
      assert.equal(submitted.action.startsWith(`${fake.url}/settings/apps/new?state=`), true);
      assert.match(submitted.manifest.name, /^aos-octo-[0-9a-f]{4}$/);
      assert.equal(submitted.manifest.public, false);
      assert.deepEqual(submitted.manifest.hook_attributes.active, false);
      assert.deepEqual(submitted.manifest.default_permissions, { contents: "write", pull_requests: "write" });
      assert.match(submitted.manifest.redirect_url, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);

      assert.equal(wrongStateStatus, 400);
      assert.deepEqual(fake.conversions, ["the-manifest-code"], "only the callback with the right state is converted");

      assert.equal(readFileSync(keyFile, "utf8"), PEM);
      assert.equal(fileMode(keyFile), 0o600);
      assert.equal(fileMode(paths.secretsEnv), 0o600);
      assert.equal(
        readFileSync(paths.secretsEnv, "utf8"),
        `OPENAI_API_KEY=sk-existing\nAOS_GITHUB_APP_ID=${APP_ID}\nAOS_GITHUB_APP_KEY_FILE=${keyFile}\n\n[pi]\nMY_KEY=pi-only\n`,
      );

      assert.equal(opened[1], `${fake.url}/apps/aos-octo-test/installations/new`);
      const printed = lines.join("\n");
      assert.match(printed, /All repositories/);
      assert.match(printed, /Installed on octo \(All repositories\)/);
      for (const secret of [CLIENT_SECRET, WEBHOOK_SECRET, "PRIVATE KEY"]) assert.ok(!printed.includes(secret));
      assert.ok(!readFileSync(paths.secretsEnv, "utf8").includes(CLIENT_SECRET));
      assert.ok(!readFileSync(paths.secretsEnv, "utf8").includes(WEBHOOK_SECRET));
    } finally {
      await fake.close();
    }
  });

  test("reports an App that is not installed yet", async () => {
    const fake = await startFakeGithub();
    const { paths } = freshRoot();
    const lines: string[] = [];
    let browser: Promise<void> = Promise.resolve();
    try {
      const code = await setupGithubApp({
        paths,
        force: false,
        hostEnv: {},
        githubUrl: fake.url,
        apiUrl: fake.url,
        out: (line) => lines.push(line),
        lookupLogin: () => "octo",
        installPollMs: 10,
        installTimeoutMs: 100,
        openUrl: (url) => {
          if (!url.endsWith("/")) return;
          browser = (async () => {
            const { manifest, action } = await readManifestPage(url);
            const state = new URL(action).searchParams.get("state") ?? "";
            await fetch(`${manifest.redirect_url}?code=abc&state=${state}`);
          })();
        },
      });
      await browser;
      assert.equal(code, 1);
      assert.match(lines.join("\n"), /No installation found yet/);
    } finally {
      await fake.close();
    }
  });

  test("says so and changes nothing when GitHub access is already configured", async () => {
    const { paths, keyFile } = freshRoot("AOS_GITHUB_APP_ID=5289758\nAOS_GITHUB_APP_KEY_FILE=/somewhere/key.pem\n");
    const lines: string[] = [];
    const opened: string[] = [];
    const code = await setupGithubApp({
      paths,
      force: false,
      hostEnv: {},
      out: (line) => lines.push(line),
      openUrl: (url) => opened.push(url),
      lookupLogin: () => assert.fail("must not look anything up"),
    });
    assert.equal(code, 0);
    assert.match(lines.join("\n"), /already configured/);
    assert.deepEqual(opened, []);
    assert.equal(existsSync(keyFile), false);
    assert.equal(readFileSync(paths.secretsEnv, "utf8"), "AOS_GITHUB_APP_ID=5289758\nAOS_GITHUB_APP_KEY_FILE=/somewhere/key.pem\n");
  });

  test("refuses to overwrite an existing key unless forced", async () => {
    const fake = await startFakeGithub();
    const { paths, keyFile } = freshRoot();
    writeFileSync(keyFile, "existing key", { mode: 0o600 });
    const before = readFileSync(paths.secretsEnv, "utf8");
    try {
      await assert.rejects(
        setupGithubApp({ paths, force: false, hostEnv: {}, githubUrl: fake.url, apiUrl: fake.url, out: () => {}, lookupLogin: () => "octo", openUrl: () => assert.fail("no browser") }),
        (error: unknown) => error instanceof AosError && /already exists/.test(error.message),
      );
      assert.equal(readFileSync(keyFile, "utf8"), "existing key");
      assert.equal(readFileSync(paths.secretsEnv, "utf8"), before);
      assert.deepEqual(fake.conversions, []);
    } finally {
      await fake.close();
    }
  });

  test("--force replaces an existing configuration", async () => {
    const fake = await startFakeGithub();
    const { paths, keyFile } = freshRoot("AOS_GITHUB_APP_ID=1\nAOS_GITHUB_APP_KEY_FILE=/old/key.pem\nOPENAI_API_KEY=sk\n");
    writeFileSync(keyFile, "old key", { mode: 0o644 });
    fake.installations = [{ account: { login: "octo" }, repository_selection: "selected" }];
    const lines: string[] = [];
    let browser: Promise<void> = Promise.resolve();
    try {
      const code = await setupGithubApp({
        paths,
        force: true,
        hostEnv: {},
        githubUrl: fake.url,
        apiUrl: fake.url,
        out: (line) => lines.push(line),
        lookupLogin: () => "octo",
        installPollMs: 10,
        installTimeoutMs: 1000,
        openUrl: (url) => {
          if (!url.endsWith("/")) return;
          browser = (async () => {
            const { manifest, action } = await readManifestPage(url);
            await fetch(`${manifest.redirect_url}?code=abc&state=${new URL(action).searchParams.get("state")}`);
          })();
        },
      });
      await browser;
      assert.equal(code, 0);
      assert.equal(readFileSync(keyFile, "utf8"), PEM);
      assert.equal(fileMode(keyFile), 0o600);
      assert.equal(
        readFileSync(paths.secretsEnv, "utf8"),
        `AOS_GITHUB_APP_ID=${APP_ID}\nAOS_GITHUB_APP_KEY_FILE=${keyFile}\nOPENAI_API_KEY=sk\n`,
      );
      assert.match(lines.join("\n"), /Only selected repositories are covered/);
    } finally {
      await fake.close();
    }
  });

  test("a rejected manifest code leaves no key and no settings behind", async () => {
    const fake = await startFakeGithub();
    fake.failConversion = true;
    const { paths, keyFile } = freshRoot();
    const before = readFileSync(paths.secretsEnv, "utf8");
    let browser: Promise<void> = Promise.resolve();
    try {
      await assert.rejects(
        setupGithubApp({
          paths,
          force: false,
          hostEnv: {},
          githubUrl: fake.url,
          apiUrl: fake.url,
          out: () => {},
          lookupLogin: () => "octo",
          openUrl: (url) => {
            browser = (async () => {
              const { manifest, action } = await readManifestPage(url);
              await fetch(`${manifest.redirect_url}?code=bad&state=${new URL(action).searchParams.get("state")}`);
            })();
          },
        }),
        (error: unknown) => error instanceof AosError && /did not accept the app manifest code/.test(error.message),
      );
      await browser;
      assert.equal(existsSync(keyFile), false);
      assert.equal(readFileSync(paths.secretsEnv, "utf8"), before);
    } finally {
      await fake.close();
    }
  });

  test("asks for the login when gh cannot supply it", async () => {
    const { paths } = freshRoot();
    await assert.rejects(
      setupGithubApp({
        paths,
        force: false,
        hostEnv: {},
        out: () => {},
        lookupLogin: () => undefined,
        askLogin: async () => "not a login!",
        openUrl: () => assert.fail("no browser"),
      }),
      (error: unknown) => error instanceof AosError && /is not a GitHub username/.test(error.message),
    );
  });
});

describe("setTopLevelKeys", () => {
  test("replaces in place, fills the template placeholder, and inserts before the first section", () => {
    const entries = { AOS_GITHUB_APP_ID: "7", AOS_GITHUB_APP_KEY_FILE: "/k.pem" };
    assert.equal(
      setTopLevelKeys("A=1\nAOS_GITHUB_APP_ID=old\n# AOS_GITHUB_APP_KEY_FILE=\n[pi]\nAOS_GITHUB_APP_ID=agent-only\n", entries),
      "A=1\nAOS_GITHUB_APP_ID=7\nAOS_GITHUB_APP_KEY_FILE=/k.pem\n[pi]\nAOS_GITHUB_APP_ID=agent-only\n",
    );
    assert.equal(setTopLevelKeys("", entries), "AOS_GITHUB_APP_ID=7\nAOS_GITHUB_APP_KEY_FILE=/k.pem\n");
    assert.equal(setTopLevelKeys("[pi]\nX=1\n", entries), "AOS_GITHUB_APP_ID=7\nAOS_GITHUB_APP_KEY_FILE=/k.pem\n[pi]\nX=1\n");
  });
});
