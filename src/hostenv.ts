import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const KEPT_HOST_VARS = new Set([
  "HOME",
  "LANG",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "USER",
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS_VERIFY",
]);

/** Terminal hints forwarded into the container so the agent TUI renders like it does on the host. */
const TERMINAL_VARS = ["COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION"];

/**
 * Environment for the aos process while it drives Sandcastle and Docker.
 *
 * Sandcastle copies host variables named in a project's `.sandcastle/.env`
 * into the container, so everything except what Docker needs is dropped.
 * Sandcastle also runs host git in the project; the GIT_CONFIG_* entries keep
 * that git from running repository hooks or an fsmonitor daemon.
 */
export function sandcastleHostEnv(hostEnv: NodeJS.ProcessEnv, home = homedir()): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(hostEnv)) {
    if (value !== undefined && (KEPT_HOST_VARS.has(key) || key.startsWith("LC_"))) env[key] = value;
  }
  Object.assign(env, dockerEndpointEnv(env, home));
  env.DOCKER_CLI_HINTS = "false";
  env.GIT_CONFIG_COUNT = "2";
  env.GIT_CONFIG_KEY_0 = "core.hooksPath";
  env.GIT_CONFIG_VALUE_0 = "/dev/null";
  env.GIT_CONFIG_KEY_1 = "core.fsmonitor";
  env.GIT_CONFIG_VALUE_1 = "false";
  return env;
}

/** Replaces process.env in place; child processes spawned afterwards inherit only `env`. */
export function replaceProcessEnv(env: Record<string, string>): void {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
}

/**
 * Docker Desktop on macOS serves its socket at ~/.docker/run/docker.sock and
 * may not create /var/run/docker.sock. When nothing else selects an endpoint
 * (no DOCKER_HOST, no DOCKER_CONTEXT, no current context in the docker CLI
 * config), point DOCKER_HOST at the Desktop socket.
 */
export function dockerEndpointEnv(
  env: NodeJS.ProcessEnv,
  home = homedir(),
  defaultSocket = "/var/run/docker.sock",
): Record<string, string> {
  if (env.DOCKER_HOST || env.DOCKER_CONTEXT) return {};
  if (currentDockerContext(env.DOCKER_CONFIG ?? join(home, ".docker"))) return {};
  if (existsSync(defaultSocket)) return {};
  const desktopSocket = join(home, ".docker", "run", "docker.sock");
  return existsSync(desktopSocket) ? { DOCKER_HOST: `unix://${desktopSocket}` } : {};
}

function currentDockerContext(configDir: string): string | undefined {
  try {
    const config = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8")) as { currentContext?: unknown };
    const context = config.currentContext;
    return typeof context === "string" && context !== "" && context !== "default" ? context : undefined;
  } catch {
    return undefined;
  }
}

export function terminalEnv(hostEnv: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = { TERM: "xterm-256color" };
  for (const key of TERMINAL_VARS) {
    const value = hostEnv[key];
    if (value) env[key] = value;
  }
  return env;
}
