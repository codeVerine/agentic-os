import { mkdirSync } from "node:fs";
import { AGENT_NAMES, AGENTS } from "./agents.ts";
import type { AosPaths } from "./paths.ts";
import { ensureAgentStateDirs, ensurePrivateDir, ensureSecretsEnvFile } from "./secrets.ts";

export function initRoot(paths: AosPaths): void {
  mkdirSync(paths.projects, { recursive: true });
  mkdirSync(paths.sessions, { recursive: true });
  ensurePrivateDir(paths.secrets);
  const created = ensureSecretsEnvFile(paths.secretsEnv);
  for (const name of AGENT_NAMES) ensureAgentStateDirs(paths.secrets, AGENTS[name]);

  console.log(`aos root      ${paths.root}`);
  console.log(`projects      ${paths.projects}`);
  console.log(`secrets       ${paths.secrets} (0700)`);
  console.log(`secrets env   ${paths.secretsEnv} (0600${created ? ", created from template" : ""})`);
  console.log(`agent logins  ${AGENT_NAMES.map((name) => `${paths.secrets}/${name}`).join(", ")}`);
}
