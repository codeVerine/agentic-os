import { createPrivateKey, createSign, randomBytes, type KeyObject } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AosError } from "./errors.ts";
import { spawnGit } from "./git.ts";
import { assertPrivate, ensurePrivateDir, GITHUB_APP_ID_KEY, GITHUB_APP_KEY_FILE_KEY, type SecretsEnv } from "./secrets.ts";

const API_URL = "https://api.github.com";
const API_VERSION = "2022-11-28";
/** One token per repository is shared by every session; it is replaced when less than this remains. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 60_000;
const POLL_MS = 100;
const REQUEST_ID = /^[0-9a-f]{32}$/;
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** The only permissions a token carries; no administration, no workflows, no merge-capable scopes beyond PR writes. */
export const TOKEN_PERMISSIONS = { contents: "write", pull_requests: "write" } as const;

export interface GithubAppConfig {
  readonly appId: string;
  readonly keyFile: string;
}

export type GithubSetup =
  | { readonly state: "unconfigured" }
  | { readonly state: "invalid"; readonly problem: string }
  | { readonly state: "ready"; readonly config: GithubAppConfig };

export interface RepoRef {
  readonly owner: string;
  readonly name: string;
}

export type RemoteKind =
  | { readonly kind: "https"; readonly repo: RepoRef }
  | { readonly kind: "ssh"; readonly repo: RepoRef }
  | { readonly kind: "other" };

export interface GithubApiOptions {
  readonly baseUrl?: string;
  /** Milliseconds since the epoch; replaced in tests to exercise expiry. */
  readonly now?: () => number;
}

export function repoSlug(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`;
}

/** Reads the App id and key path from the secrets env file and checks the key can be used. */
export function githubSetup(secrets: SecretsEnv, home = homedir()): GithubSetup {
  const appId = secrets.shared.get(GITHUB_APP_ID_KEY);
  const keyFile = secrets.shared.get(GITHUB_APP_KEY_FILE_KEY);
  if (appId === undefined && keyFile === undefined) return { state: "unconfigured" };
  if (appId === undefined || keyFile === undefined) {
    const missing = appId === undefined ? GITHUB_APP_ID_KEY : GITHUB_APP_KEY_FILE_KEY;
    return { state: "invalid", problem: `${missing} is not set: GitHub access needs both ${GITHUB_APP_ID_KEY} and ${GITHUB_APP_KEY_FILE_KEY}.` };
  }
  if (!SEGMENT.test(appId)) {
    return { state: "invalid", problem: `${GITHUB_APP_ID_KEY} must be the GitHub App's id or client id, got "${appId}".` };
  }
  const config = { appId, keyFile: keyFile === "~" || keyFile.startsWith("~/") ? join(home, keyFile.slice(1)) : resolve(keyFile) };
  try {
    readPrivateKey(config.keyFile);
  } catch (error) {
    if (!(error instanceof AosError)) throw error;
    return { state: "invalid", problem: error.message };
  }
  return { state: "ready", config };
}

function readPrivateKey(keyFile: string): KeyObject {
  if (!existsSync(keyFile)) throw new AosError(`${GITHUB_APP_KEY_FILE_KEY} points at ${keyFile}, which does not exist.`);
  assertPrivate(keyFile, 0o600);
  try {
    return createPrivateKey(readFileSync(keyFile));
  } catch {
    throw new AosError(`${keyFile} is not a PEM private key. Download one from the GitHub App's settings page.`);
  }
}

export function classifyRemote(url: string): RemoteKind {
  const trimmed = url.trim();
  const scp = /^(?:[^@/\s]+@)?github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (scp && !trimmed.includes("://")) return repoKind("ssh", scp[1], scp[2]);
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { kind: "other" };
  }
  if (parsed.hostname.toLowerCase() !== "github.com") return { kind: "other" };
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) return { kind: "other" };
  const name = (parts[1] ?? "").replace(/\.git$/i, "");
  if (parsed.protocol === "https:") return repoKind("https", parts[0], name);
  if (parsed.protocol === "ssh:" || parsed.protocol === "git+ssh:") return repoKind("ssh", parts[0], name);
  return { kind: "other" };
}

function repoKind(kind: "https" | "ssh", owner: string | undefined, name: string | undefined): RemoteKind {
  const repo = owner !== undefined && name !== undefined ? repoRef(owner, name) : undefined;
  return repo ? { kind, repo } : { kind: "other" };
}

function repoRef(owner: string, name: string): RepoRef | undefined {
  const bad = (part: string): boolean => !SEGMENT.test(part) || /^\.+$/.test(part);
  return bad(owner) || bad(name) ? undefined : { owner, name };
}

/** Parses the `owner/name[.git]` path git passes to a credential helper. */
export function parseRepoPath(path: string): RepoRef | undefined {
  const parts = path.replace(/^\/+/, "").replace(/\/+$/, "").split("/");
  if (parts.length !== 2) return undefined;
  return repoRef(parts[0] ?? "", (parts[1] ?? "").replace(/\.git$/i, ""));
}

const sameRepo = (a: RepoRef, b: RepoRef): boolean =>
  a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function appJwt(config: GithubAppConfig, nowMs: number): string {
  const seconds = Math.floor(nowMs / 1000);
  const input = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
    JSON.stringify({ iat: seconds - 60, exp: seconds + 9 * 60, iss: config.appId }),
  )}`;
  const signature = createSign("RSA-SHA256").update(input).sign(readPrivateKey(config.keyFile));
  return `${input}.${base64url(signature)}`;
}

async function api(baseUrl: string, method: "GET" | "POST", path: string, jwt: string, body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
        "User-Agent": "aos",
        "X-GitHub-Api-Version": API_VERSION,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new AosError(`Could not reach the GitHub API: ${(error as Error).message}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new AosError(`GitHub API ${method} ${path} failed with ${response.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as unknown;
}

export interface MintedToken {
  readonly token: string;
  /** Milliseconds since the epoch. */
  readonly expiresAt: number;
}

/**
 * Mints an installation token for exactly one repository with contents and pull request write,
 * authenticating as the App with a short-lived JWT signed by the key on the Mac.
 */
export async function mintInstallationToken(
  config: GithubAppConfig,
  repo: RepoRef,
  options: GithubApiOptions = {},
): Promise<MintedToken> {
  const baseUrl = options.baseUrl ?? API_URL;
  const jwt = appJwt(config, (options.now ?? Date.now)());
  const slug = repoSlug(repo);
  let installation: unknown;
  try {
    installation = await api(baseUrl, "GET", `/repos/${slug}/installation`, jwt);
  } catch (error) {
    if (error instanceof AosError && / failed with 404/.test(error.message)) {
      throw new AosError(`GitHub App ${config.appId} is not installed on ${slug}. Install it on this repository, or on all your repositories.`);
    }
    throw error;
  }
  const installationId = (installation as { id?: unknown }).id;
  if (typeof installationId !== "number") throw new AosError(`GitHub returned no installation id for ${slug}.`);
  const minted = (await api(baseUrl, "POST", `/app/installations/${installationId}/access_tokens`, jwt, {
    repositories: [repo.name],
    permissions: TOKEN_PERMISSIONS,
  })) as { token?: unknown; expires_at?: unknown };
  const expiresAt = typeof minted.expires_at === "string" ? Date.parse(minted.expires_at) : Number.NaN;
  if (typeof minted.token !== "string" || Number.isNaN(expiresAt)) {
    throw new AosError(`GitHub returned an unexpected token response for ${slug}.`);
  }
  return { token: minted.token, expiresAt };
}

interface CacheEntry {
  readonly appId: string;
  readonly token: string;
  readonly expiresAt: number;
}

function readCache(file: string, appId: string, nowMs: number): string | undefined {
  try {
    const entry = JSON.parse(readFileSync(file, "utf8")) as Partial<CacheEntry>;
    if (entry.appId !== appId || typeof entry.token !== "string" || typeof entry.expiresAt !== "number") return undefined;
    return entry.expiresAt - nowMs > REFRESH_MARGIN_MS ? entry.token : undefined;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function lockOwner(lockPath: string): string | undefined {
  try {
    return readFileSync(lockPath, "utf8");
  } catch {
    return undefined;
  }
}

async function withLock<T>(lockPath: string, run: () => Promise<T>): Promise<T> {
  const owner = randomBytes(16).toString("hex");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      writeFileSync(lockPath, owner, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) unlinkSync(lockPath);
      } catch {
        // The holder released it between the checks; try to take it again.
      }
      if (Date.now() > deadline) throw new AosError(`Timed out waiting for another aos session to mint a token (${lockPath}).`);
      await sleep(50);
    }
  }
  try {
    return await run();
  } finally {
    if (lockOwner(lockPath) === owner) rmSync(lockPath, { force: true });
  }
}

/**
 * The token for `repo`, shared through `tokensDir` by every aos process on this Mac. It is minted
 * under a file lock so parallel sessions of one repository mint once, and again only when less
 * than five minutes of its hour remain.
 */
export async function tokenForRepo(
  config: GithubAppConfig,
  repo: RepoRef,
  tokensDir: string,
  options: GithubApiOptions = {},
): Promise<string> {
  const now = options.now ?? Date.now;
  const file = join(tokensDir, `${repo.owner.toLowerCase()}__${repo.name.toLowerCase()}.json`);
  const cached = readCache(file, config.appId, now());
  if (cached !== undefined) return cached;
  ensurePrivateDir(tokensDir);
  return withLock(`${file}.lock`, async () => {
    const raced = readCache(file, config.appId, now());
    if (raced !== undefined) return raced;
    const minted = await mintInstallationToken(config, repo, options);
    const staging = `${file}.${process.pid}.tmp`;
    writeFileSync(staging, JSON.stringify({ appId: config.appId, ...minted }), { mode: 0o600 });
    renameSync(staging, file);
    return minted.token;
  });
}

interface CredentialRequest {
  readonly host?: unknown;
  readonly path?: unknown;
}

type CredentialResponse = { readonly ok: true; readonly token: string } | { readonly ok: false; readonly message: string };

export interface GithubAccessOptions {
  readonly secrets: SecretsEnv;
  /** Host directory of the repository whose origin remote names the one repository this launch may use. */
  readonly repoRoot: string;
  /** Host directory created for this launch and mounted only at `containerSpoolDir`; the container cannot write above it. */
  readonly spoolDir: string;
  readonly containerSpoolDir: string;
  readonly tokensDir: string;
  readonly api?: GithubApiOptions;
  readonly home?: string;
  /** Receives a one-line note the user should see before the agent starts. */
  readonly notify?: (message: string) => void;
}

export interface GithubAccess {
  /** Environment for the container: how the credential helper reaches aos, or why it cannot. */
  readonly env: Record<string, string>;
  readonly stop: () => void;
}

const UNCONFIGURED =
  `GitHub access is not configured, so git cannot pull or push and gh is not signed in. ` +
  `On the Mac, set ${GITHUB_APP_ID_KEY} and ${GITHUB_APP_KEY_FILE_KEY} in ~/AgenticOS/secrets/env (see the aos README, "GitHub access") and start a new session.`;

function unavailable(message: string): GithubAccess {
  return { env: { AOS_GITHUB_STATUS: message }, stop: () => {} };
}

/**
 * Starts the host side of GitHub access for one launch. The container asks for tokens by writing
 * request files into the spool directory mounted for this launch; this process answers them.
 * Only that spool directory is shared: the private key and every other repository's token stay here.
 * A plain directory is used because Docker Desktop cannot pass a host unix socket into a container,
 * and a TCP port on the Mac's localhost would be reachable by other local processes.
 */
export function prepareGithubAccess(options: GithubAccessOptions): GithubAccess {
  const setup = githubSetup(options.secrets, options.home);
  if (setup.state === "unconfigured") return unavailable(UNCONFIGURED);
  if (setup.state === "invalid") return unavailable(`GitHub access is misconfigured: ${setup.problem}`);

  const origin = spawnGit(["-C", options.repoRoot, "remote", "get-url", "origin"]);
  const remote = origin.status === 0 ? classifyRemote(origin.stdout) : ({ kind: "other" } as const);
  if (remote.kind === "ssh") {
    const message =
      `This project's origin remote uses SSH, and aos gives agents GitHub access over HTTPS only. ` +
      `Run: git remote set-url origin https://github.com/${repoSlug(remote.repo)}.git`;
    options.notify?.(message);
    return unavailable(message);
  }
  if (remote.kind === "other") {
    return unavailable(
      origin.status === 0
        ? `This project's origin remote ${origin.stdout.trim()} is not an https://github.com remote, so aos has no GitHub access for it.`
        : `This project has no origin remote, so aos has no GitHub repository to give access to.`,
    );
  }

  const spool = options.spoolDir;
  const allowed = remote.repo;
  const inFlight = new Set<string>();

  const readRequest = (file: string): CredentialRequest => {
    const fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile()) throw new AosError(`${file} is not a regular file.`);
      return JSON.parse(readFileSync(fd, "utf8")) as CredentialRequest;
    } finally {
      closeSync(fd);
    }
  };

  const answer = async (request: CredentialRequest): Promise<CredentialResponse> => {
    if (request.host !== undefined && request.host !== "github.com") {
      return { ok: false, message: `aos only gives access to github.com, not ${String(request.host)}.` };
    }
    const asked = typeof request.path === "string" && request.path !== "" ? parseRepoPath(request.path) : allowed;
    if (asked === undefined) return { ok: false, message: `aos could not read a repository from "${String(request.path)}".` };
    if (!sameRepo(asked, allowed)) {
      return { ok: false, message: `This session has GitHub access to ${repoSlug(allowed)} only, not ${repoSlug(asked)}.` };
    }
    try {
      return { ok: true, token: await tokenForRepo(setup.config, allowed, options.tokensDir, options.api) };
    } catch {
      return { ok: false, message: `aos could not get a GitHub token for ${repoSlug(allowed)}.` };
    }
  };

  const serve = async (id: string): Promise<void> => {
    const requestFile = join(spool, `${id}.req`);
    let response: CredentialResponse;
    try {
      response = await answer(readRequest(requestFile));
    } catch {
      response = { ok: false, message: "aos could not answer the request." };
    }
    rmSync(requestFile, { force: true });
    const staging = join(spool, `${id}.res.tmp`);
    rmSync(staging, { force: true });
    writeFileSync(staging, JSON.stringify(response), { mode: 0o600, flag: "wx" });
    renameSync(staging, join(spool, `${id}.res`));
  };

  const poll = setInterval(() => {
    let names: string[];
    try {
      names = readdirSync(spool);
    } catch {
      return;
    }
    for (const name of names) {
      const id = name.endsWith(".req") ? name.slice(0, -".req".length) : "";
      if (!REQUEST_ID.test(id) || inFlight.has(id)) continue;
      inFlight.add(id);
      void serve(id)
        .catch(() => {})
        .finally(() => inFlight.delete(id));
    }
  }, POLL_MS);
  poll.unref();

  return { env: { AOS_GITHUB_SPOOL: options.containerSpoolDir }, stop: () => clearInterval(poll) };
}
