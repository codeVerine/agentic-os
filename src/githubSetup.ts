import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { AosError } from "./errors.ts";
import { ensurePrivateDir } from "./fsutil.ts";
import {
  type AppInstallation,
  type GithubAppConfig,
  GITHUB_API_URL,
  githubFetch,
  githubSetup,
  listAppInstallations,
  TOKEN_PERMISSIONS,
} from "./github.ts";
import type { AosPaths } from "./paths.ts";
import {
  GITHUB_APP_ID_KEY,
  GITHUB_APP_KEY_FILE_KEY,
  readSecretsEnv,
  writeSecretsEnvKeys,
} from "./secrets.ts";

const GITHUB_URL = "https://github.com";
const LOGIN = /^[A-Za-z0-9-]+$/;
const HOMEPAGE = "https://github.com/codeVerine/agentic-os";
const KEY_FILE_NAME = "github-app.pem";

export interface GithubAppSetupOptions {
  readonly paths: AosPaths;
  readonly force: boolean;
  /** The environment aos was started with, which `gh` needs to find its login. */
  readonly hostEnv: NodeJS.ProcessEnv;
  readonly githubUrl?: string;
  readonly apiUrl?: string;
  readonly out?: (line: string) => void;
  /** Opens a URL in the user's browser; the URL is always printed as well. */
  readonly openUrl?: (url: string) => void;
  /** The GitHub login of the user, or undefined when it has to be asked. */
  readonly lookupLogin?: () => string | undefined;
  readonly askLogin?: () => Promise<string>;
  readonly callbackTimeoutMs?: number;
  readonly installPollMs?: number;
  readonly installTimeoutMs?: number;
}

interface Conversion {
  readonly id: number;
  readonly slug: string;
  readonly pem: string;
}

function defaultOpenUrl(url: string): void {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(command, [url], { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

function ghLogin(env: NodeJS.ProcessEnv): string | undefined {
  const result = spawnSync("gh", ["api", "user", "--jq", ".login"], { encoding: "utf8", env, timeout: 15_000 });
  const login = result.status === 0 ? result.stdout.trim() : "";
  return LOGIN.test(login) ? login : undefined;
}

async function askLogin(): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await terminal.question("Your GitHub username (gh is not logged in): ")).trim();
  } finally {
    terminal.close();
  }
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export interface Manifest {
  readonly name: string;
  readonly url: string;
  readonly redirect_url: string;
  readonly public: false;
  readonly hook_attributes: { readonly url: string; readonly active: false };
  readonly default_permissions: typeof TOKEN_PERMISSIONS;
}

export function appManifest(name: string, redirectUrl: string): Manifest {
  return {
    name,
    url: HOMEPAGE,
    redirect_url: redirectUrl,
    public: false,
    hook_attributes: { url: HOMEPAGE, active: false },
    default_permissions: TOKEN_PERMISSIONS,
  };
}

/** The page the browser opens: it posts the manifest to GitHub, which then asks the user to confirm. */
function manifestPage(manifest: Manifest, state: string, githubUrl = GITHUB_URL): string {
  const action = `${githubUrl}/settings/apps/new?state=${encodeURIComponent(state)}`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>aos GitHub App setup</title></head>
<body>
<p>Sending the aos GitHub App to GitHub. Confirm the app name there, then click Create GitHub App.</p>
<form id="manifest" action="${escapeHtml(action)}" method="post">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<noscript><button type="submit">Continue to GitHub</button></noscript>
</form>
<script>document.getElementById("manifest").submit();</script>
</body></html>
`;
}

async function convertManifest(code: string, apiUrl: string): Promise<Conversion> {
  const response = await githubFetch(`${apiUrl}/app-manifests/${encodeURIComponent(code)}/conversions`, { method: "POST" });
  if (!response.ok) {
    throw new AosError(`GitHub did not accept the app manifest code (status ${response.status}). Run "aos github setup" again.`);
  }
  const body = (await response.json()) as { id?: unknown; slug?: unknown; pem?: unknown };
  if (typeof body.id !== "number" || typeof body.slug !== "string" || typeof body.pem !== "string" || !body.pem.includes("PRIVATE KEY")) {
    throw new AosError("GitHub returned an unexpected response for the new App.");
  }
  return { id: body.id, slug: body.slug, pem: body.pem };
}

/** Starts a localhost server and resolves with the callback's code once its state matches. */
function waitForCallback(
  server: Server,
  state: string,
  page: (redirectUrl: string) => string,
  timeoutMs: number,
): { redirectUrl: string; code: Promise<string> } {
  const port = (server.address() as AddressInfo).port;
  const redirectUrl = `http://127.0.0.1:${port}/callback`;
  const html = page(redirectUrl);
  const code = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AosError("Timed out waiting for the GitHub App to be created in the browser.")), timeoutMs);
    server.on("request", (request, response) => {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
      const reply = (status: number, text: string): void => {
        response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><meta charset="utf-8"><p>${escapeHtml(text)}</p>`);
      };
      if (url.pathname === "/") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(html);
      } else if (url.pathname === "/callback") {
        const returned = url.searchParams.get("code");
        if (url.searchParams.get("state") !== state || !returned) {
          reply(400, "This request does not belong to the aos setup that is running. Nothing was changed.");
          return;
        }
        reply(200, "The GitHub App was created. Return to the terminal to finish the setup.");
        clearTimeout(timer);
        resolve(returned);
      } else {
        reply(404, "Not found.");
      }
    });
  });
  return { redirectUrl, code };
}

async function waitForInstallation(
  config: GithubAppConfig,
  apiUrl: string,
  intervalMs: number,
  timeoutMs: number,
): Promise<AppInstallation | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const [first] = await listAppInstallations(config, { baseUrl: apiUrl });
      if (first) return first;
    } catch {
      // GitHub may take a moment to accept the new App's credentials.
    }
    if (Date.now() >= deadline) return undefined;
    await sleep(intervalMs);
  }
}

/**
 * `aos github setup`: creates the GitHub App through GitHub's manifest flow, stores its private key
 * and id for aos, and checks that it is installed. GitHub offers no API to create an App or download
 * its key, so the one confirmation click happens in the browser.
 */
export async function setupGithubApp(options: GithubAppSetupOptions): Promise<number> {
  const out = options.out ?? ((line: string) => console.log(line));
  const githubUrl = options.githubUrl ?? GITHUB_URL;
  const apiUrl = options.apiUrl ?? GITHUB_API_URL;
  const openUrl = options.openUrl ?? defaultOpenUrl;
  const { paths } = options;
  const keyFile = join(paths.secrets, KEY_FILE_NAME);

  const secrets = readSecretsEnv(paths.secretsEnv);
  const configured = secrets.shared.get(GITHUB_APP_ID_KEY) ?? secrets.shared.get(GITHUB_APP_KEY_FILE_KEY);
  if (configured !== undefined && !options.force) {
    out(`GitHub access is already configured in ${paths.secretsEnv}. Run "aos doctor" to check it, or "aos github setup --force" to create a new App.`);
    return 0;
  }
  if (existsSync(keyFile) && !options.force) {
    throw new AosError(`${keyFile} already exists. Refusing to overwrite a private key: move it away, or run "aos github setup --force".`);
  }

  const login = (options.lookupLogin ?? (() => ghLogin(options.hostEnv)))() ?? (await (options.askLogin ?? askLogin)());
  if (!LOGIN.test(login)) throw new AosError(`"${login}" is not a GitHub username.`);
  const name = `aos-${login.slice(0, 20)}-${randomBytes(2).toString("hex")}`;
  const state = randomBytes(16).toString("hex");

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const callback = waitForCallback(
      server,
      state,
      (redirectUrl) => manifestPage(appManifest(name, redirectUrl), state, githubUrl),
      options.callbackTimeoutMs ?? 10 * 60 * 1000,
    );
    const startUrl = callback.redirectUrl.replace(/\/callback$/, "/");
    out(`Creating the GitHub App "${name}" for ${login} (contents and pull requests write, no webhook).`);
    out(`Opening ${startUrl} in your browser. If it does not open, open that URL yourself.`);
    out("On GitHub, confirm the app name and click Create GitHub App.");
    openUrl(startUrl);

    const created = await convertManifest(await callback.code, apiUrl);

    ensurePrivateDir(paths.secrets);
    writeFileSync(keyFile, created.pem, { mode: 0o600, flag: options.force ? "w" : "wx" });
    chmodSync(keyFile, 0o600);
    writeSecretsEnvKeys(paths.secretsEnv, { [GITHUB_APP_ID_KEY]: String(created.id), [GITHUB_APP_KEY_FILE_KEY]: keyFile });
    out(`Created GitHub App ${created.slug} (id ${created.id}). Private key saved to ${keyFile} (mode 0600); id and key path set in ${paths.secretsEnv}.`);

    const installUrl = `${githubUrl}/apps/${created.slug}/installations/new`;
    out(`Now install it: ${installUrl}`);
    out('Pick "All repositories" so new repositories are covered, then click Install.');
    openUrl(installUrl);

    const setup = githubSetup(readSecretsEnv(paths.secretsEnv));
    if (setup.state !== "ready") throw new AosError(setup.state === "invalid" ? setup.problem : "The new GitHub App settings could not be read back.");
    const installation = await waitForInstallation(
      setup.config,
      apiUrl,
      options.installPollMs ?? 3000,
      options.installTimeoutMs ?? 3 * 60 * 1000,
    );
    if (installation === undefined) {
      out(`No installation found yet. Install the App at ${installUrl}, then run "aos doctor".`);
      return 1;
    }
    out(`Installed on ${installation.account} (${installation.repositorySelection === "all" ? "All repositories" : "selected repositories"}).`);
    if (installation.repositorySelection !== "all") {
      out(`Only selected repositories are covered. Choose "All repositories" in the App's installation settings so new repositories work without another step.`);
    }
    out('GitHub access is ready. Run "aos image build" if you have not rebuilt the image since upgrading aos.');
    return 0;
  } finally {
    server.close();
    server.closeIdleConnections();
  }
}
