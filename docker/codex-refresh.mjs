// Serializes Codex ChatGPT token refreshes across every container that shares
// one CODEX_HOME.
//
// Codex rotates its refresh token on every refresh and guards refreshes only
// with an in-process lock, so two containers refreshing at the same moment send
// the same refresh token and the second is rejected as already used. Codex
// sends refreshes to CODEX_REFRESH_TOKEN_URL_OVERRIDE when set; aos points it
// here. Each refresh runs under a lock directory in CODEX_HOME, and the last
// successful rotation is kept so a refresh with the token it replaced gets the
// same response instead of a second upstream call.
//
//   node codex-refresh.mjs          start the server in the background, return once it listens
//   node codex-refresh.mjs serve    run the server in the foreground

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const UPSTREAM = process.env.AOS_CODEX_REFRESH_UPSTREAM ?? "https://auth.openai.com/oauth/token";
const UPSTREAM_TIMEOUT_MS = 30_000;
const STALE_LOCK_MS = 2 * UPSTREAM_TIMEOUT_MS;
const SKIPPED_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "accept-encoding"]);

if (process.argv[2] === "serve") serve();
else start();

function start() {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve"], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let ready = false;
  child.once("message", () => {
    ready = true;
    child.disconnect();
    child.unref();
  });
  child.once("exit", (code) => {
    if (ready) return;
    console.error(`aos: codex refresh lock server exited with status ${code}`);
    process.exitCode = 1;
  });
}

function serve() {
  const codexHome = process.env.CODEX_HOME;
  const listenUrl = process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE;
  if (!codexHome || !listenUrl) {
    console.error("aos: CODEX_HOME and CODEX_REFRESH_TOKEN_URL_OVERRIDE must be set");
    process.exit(1);
  }
  const { hostname, port } = new URL(listenUrl);
  const server = createServer((req, res) => {
    readBody(req)
      .then((body) => refresh(codexHome, req.headers, body))
      .catch((error) => ({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: `aos refresh lock: ${error.message}` } }),
      }))
      .then(({ status, contentType, body }) => {
        res.writeHead(status, contentType ? { "content-type": contentType } : {});
        res.end(body);
      });
  });
  server.listen(Number(port), hostname, () => process.send?.({ port: server.address().port }));
}

async function refresh(codexHome, headers, body) {
  const refreshToken = parseRefreshToken(body);
  if (refreshToken === undefined) return forward(headers, body);

  const lock = join(codexHome, ".aos-refresh.lock");
  const recordPath = join(codexHome, ".aos-refresh.json");
  await acquire(lock);
  try {
    const record = readRecord(recordPath);
    if (record?.from === refreshToken) return { status: 200, contentType: "application/json", body: record.body };
    const response = await forward(headers, body);
    if (response.status >= 200 && response.status < 300) {
      writePrivate(recordPath, JSON.stringify({ from: refreshToken, body: response.body }));
    }
    return response;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

async function forward(headers, body) {
  const upstream = await fetch(UPSTREAM, {
    method: "POST",
    headers: Object.entries(headers).filter(([name]) => !SKIPPED_HEADERS.has(name)),
    body,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  return { status: upstream.status, contentType: upstream.headers.get("content-type"), body: await upstream.text() };
}

function parseRefreshToken(body) {
  try {
    const token = JSON.parse(body).refresh_token;
    return typeof token === "string" ? token : undefined;
  } catch {
    return undefined;
  }
}

// A crashed holder leaves its lock directory behind; no refresh holds the lock
// longer than the upstream timeout, so an older lock is abandoned.
async function acquire(lock) {
  for (;;) {
    try {
      mkdirSync(lock);
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmSync(lock, { recursive: true, force: true });
    } catch {}
    await sleep(50);
  }
}

function readRecord(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function writePrivate(path, content) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  renameSync(temp, path);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
