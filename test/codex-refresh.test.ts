import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../docker/codex-refresh.mjs", import.meta.url));

/** Stands in for auth.openai.com: rotates the refresh token on every use and rejects reuse. */
function fakeAuthServer(): { server: Server; requests: string[] } {
  const requests: string[] = [];
  const used = new Set<string>();
  let generation = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const { refresh_token: token } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { refresh_token: string };
      requests.push(token);
      setTimeout(() => {
        res.setHeader("content-type", "application/json");
        if (token === "revoked" || used.has(token)) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: { code: token === "revoked" ? "refresh_token_invalidated" : "refresh_token_reused" } }));
          return;
        }
        used.add(token);
        generation += 1;
        res.end(JSON.stringify({ access_token: `access-${generation}`, refresh_token: `refresh-${generation}`, id_token: "id" }));
      }, 200);
    });
  });
  return { server, requests };
}

async function startLockServer(codexHome: string, upstream: string): Promise<{ child: ChildProcess; url: string }> {
  const child = spawn(process.execPath, [SCRIPT, "serve"], {
    env: {
      CODEX_HOME: codexHome,
      CODEX_REFRESH_TOKEN_URL_OVERRIDE: "http://127.0.0.1:0/oauth/token",
      AOS_CODEX_REFRESH_UPSTREAM: upstream,
    },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  const [message] = (await once(child, "message")) as [{ port: number }];
  return { child, url: `http://127.0.0.1:${message.port}/oauth/token` };
}

async function refresh(url: string, token: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: "codex", grant_type: "refresh_token", refresh_token: token }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("codex refresh lock server", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "aos-codex-home-"));
  const auth = fakeAuthServer();
  const lockServers: ChildProcess[] = [];
  let containerA = "";
  let containerB = "";

  before(async () => {
    auth.server.listen(0, "127.0.0.1");
    await once(auth.server, "listening");
    const upstream = `http://127.0.0.1:${(auth.server.address() as AddressInfo).port}/oauth/token`;
    const [a, b] = await Promise.all([startLockServer(codexHome, upstream), startLockServer(codexHome, upstream)]);
    lockServers.push(a.child, b.child);
    containerA = a.url;
    containerB = b.url;
  });

  after(() => {
    for (const child of lockServers) child.kill();
    auth.server.close();
    rmSync(codexHome, { recursive: true, force: true });
  });

  test("concurrent refreshes with one token from two containers reach the authority once", async () => {
    const [a, b] = await Promise.all([refresh(containerA, "refresh-0"), refresh(containerB, "refresh-0")]);
    assert.deepEqual(auth.requests, ["refresh-0"]);
    assert.equal(a.status, 200);
    assert.deepEqual(b, a);
    assert.equal(a.body.refresh_token, "refresh-1");
    assert.equal(statSync(join(codexHome, ".aos-refresh.json")).mode & 0o777, 0o600);
  });

  test("a refresh with the current token still goes to the authority", async () => {
    const result = await refresh(containerB, "refresh-1");
    assert.deepEqual(auth.requests, ["refresh-0", "refresh-1"]);
    assert.equal(result.body.refresh_token, "refresh-2");
  });

  test("authority rejections pass through unchanged and are not replayed as success", async () => {
    const first = await refresh(containerA, "revoked");
    assert.equal(first.status, 401);
    assert.deepEqual(first.body, { error: { code: "refresh_token_invalidated" } });
    const second = await refresh(containerB, "revoked");
    assert.equal(second.status, 401);
    assert.deepEqual(auth.requests, ["refresh-0", "refresh-1", "revoked", "revoked"]);
  });
});
