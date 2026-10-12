import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_NAMES, type AgentName, type AgentSpec, isAgentName } from "./agents.ts";
import { AosError } from "./errors.ts";
import { assertPrivate, ensurePrivateDir, writePrivateFileAtomic } from "./fsutil.ts";

/**
 * Parsed secrets env file. Top-level keys reach every agent that lists the key
 * in its known keys; keys under an `[agent]` section reach only that agent.
 */
export interface SecretsEnv {
  readonly shared: ReadonlyMap<string, string>;
  readonly perAgent: ReadonlyMap<AgentName, ReadonlyMap<string, string>>;
}

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECTION = /^\[\s*([^\]]*?)\s*\]$/;
const INLINE_COMMENT = /^(\s+#.*)?$/;

/** Top-level keys aos reads itself to give containers GitHub access; they are never passed into a container. */
export const GITHUB_APP_ID_KEY = "AOS_GITHUB_APP_ID";
export const GITHUB_APP_KEY_FILE_KEY = "AOS_GITHUB_APP_KEY_FILE";
const AOS_OWN_KEYS: readonly string[] = [GITHUB_APP_ID_KEY, GITHUB_APP_KEY_FILE_KEY];

export const EMPTY_SECRETS: SecretsEnv = { shared: new Map(), perAgent: new Map() };

export const ENV_TEMPLATE = `# aos secrets: KEY=VALUE lines, one per line. Keep this file mode 0600.
#
# Top-level keys are passed only to the agents that use them (see README).
# Keys under an [agent] section ([claude], [codex], [opencode], [pi]) are
# passed only to that agent, whatever their name.
#
# OPENROUTER_API_KEY=
#
# [pi]
# MY_ROUTER_API_KEY=
#
# GitHub access for agents (see README, "GitHub access"). Both are read by aos
# on the Mac and never passed into a container. The key file must be mode 0600.
#
# AOS_GITHUB_APP_ID=
# AOS_GITHUB_APP_KEY_FILE=~/AgenticOS/secrets/github-app.pem
`;

export function parseSecretsEnv(content: string, source = "secrets env"): SecretsEnv {
  const shared = new Map<string, string>();
  const perAgent = new Map<AgentName, Map<string, string>>();
  let section: Map<string, string> = shared;

  content.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    const where = `${source} line ${index + 1}`;
    if (!line || line.startsWith("#")) return;

    const sectionMatch = SECTION.exec(line);
    if (sectionMatch) {
      const name = sectionMatch[1] ?? "";
      if (!isAgentName(name)) {
        throw new AosError(`${where}: unknown section [${name}]. Expected one of: ${AGENT_NAMES.join(", ")}.`);
      }
      section = perAgent.get(name) ?? new Map();
      perAgent.set(name, section);
      return;
    }

    const body = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
    const eq = body.indexOf("=");
    if (eq === -1) throw new AosError(`${where}: expected KEY=VALUE.`);
    const key = body.slice(0, eq).trim();
    if (!KEY.test(key)) throw new AosError(`${where}: "${key}" is not a valid variable name.`);
    const value = parseValue(body.slice(eq + 1));
    if (value !== "") section.set(key, value);
  });

  return { shared, perAgent };
}

/** Quoted values are taken literally; unquoted values end at a whitespace-prefixed `#` comment. */
function parseValue(raw: string): string {
  const value = raw.trim();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1);
    if (end !== -1 && INLINE_COMMENT.test(value.slice(end + 1))) return value.slice(1, end);
  }
  return raw.replace(/\s+#.*$/, "").trim();
}

export function readSecretsEnv(path: string): SecretsEnv {
  if (!existsSync(path)) return EMPTY_SECRETS;
  assertPrivate(path, 0o600);
  return parseSecretsEnv(readFileSync(path, "utf8"), path);
}

/** Environment passed into the agent's container: its known shared keys plus its own section. */
export function selectAgentEnv(spec: AgentSpec, secrets: SecretsEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of spec.envKeys) {
    const value = secrets.shared.get(key);
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of secrets.perAgent.get(spec.name) ?? []) env[key] = value;
  return env;
}

/** Shared keys that no agent will receive, usually a typo or a key that belongs in a section. */
export function unroutedKeys(secrets: SecretsEnv, specs: readonly AgentSpec[]): string[] {
  return [...secrets.shared.keys()].filter(
    (key) => !AOS_OWN_KEYS.includes(key) && !specs.some((spec) => spec.envKeys.includes(key)),
  );
}

/** Creates secrets/<agent>/ and its state subdirectories, all mode 0700. */
export function ensureAgentStateDirs(secretsDir: string, spec: AgentSpec): string {
  const agentDir = join(secretsDir, spec.name);
  ensurePrivateDir(agentDir);
  for (const mount of spec.stateMounts) {
    if (mount.subdir) ensurePrivateDir(join(agentDir, mount.subdir));
  }
  return agentDir;
}

/**
 * Sets top-level KEY=VALUE lines without touching anything else. An existing assignment is replaced in
 * place, a commented `# KEY=` placeholder is turned into the assignment, and a new key is inserted
 * before the first [agent] section, since keys under a section reach only that agent.
 */
export function setTopLevelKeys(content: string, entries: Readonly<Record<string, string>>): string {
  const lines = content === "" ? [] : content.replace(/\n$/, "").split("\n");
  const firstSection = lines.findIndex((line) => SECTION.test(line.trim()));
  const topLevel = firstSection === -1 ? lines.length : firstSection;
  let insertAt = topLevel;
  while (insertAt > 0 && lines[insertAt - 1]?.trim() === "") insertAt -= 1;
  const insertions: string[] = [];
  for (const [key, value] of Object.entries(entries)) {
    const assignment = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
    const placeholder = new RegExp(`^\\s*#\\s*${key}\\s*=\\s*$`);
    let at = lines.findIndex((line, index) => index < topLevel && assignment.test(line));
    if (at === -1) at = lines.findIndex((line, index) => index < topLevel && placeholder.test(line));
    if (at === -1) insertions.push(`${key}=${value}`);
    else lines[at] = `${key}=${value}`;
  }
  lines.splice(insertAt, 0, ...insertions);
  return `${lines.join("\n")}\n`;
}

/** Applies `setTopLevelKeys` to the secrets env file, keeping it mode 0600; creates it when absent. */
export function writeSecretsEnvKeys(path: string, entries: Readonly<Record<string, string>>): void {
  const current = existsSync(path) ? readFileSync(path, "utf8") : ENV_TEMPLATE;
  writePrivateFileAtomic(path, setTopLevelKeys(current, entries));
}

/** Writes the env template when absent; returns true when it created the file. */
export function ensureSecretsEnvFile(path: string): boolean {
  if (existsSync(path)) {
    chmodSync(path, 0o600);
    return false;
  }
  writeFileSync(path, ENV_TEMPLATE, { mode: 0o600, flag: "wx" });
  return true;
}

/**
 * Login files the agent has not written yet. Agents create some of these files
 * empty ("{}") on first start, so a file only counts once it holds an entry.
 */
export function missingLoginFiles(spec: AgentSpec, agentDir: string): string[] {
  return spec.loginFiles.filter((file) => !holdsCredentials(join(agentDir, file)));
}

function holdsCredentials(path: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}
