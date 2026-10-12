import { mkdirSync } from "node:fs";
import { AGENT_NAMES, AGENT_SPECS } from "./agents.ts";
import { ensurePrivateDir } from "./fsutil.ts";
import type { AosPaths } from "./paths.ts";
import { ensureAgentStateDirs, ensureSecretsEnvFile } from "./secrets.ts";

export function initRoot(paths: AosPaths): void {
  mkdirSync(paths.projects, { recursive: true });
  mkdirSync(paths.sessions, { recursive: true });
  ensurePrivateDir(paths.secrets);
  const created = ensureSecretsEnvFile(paths.secretsEnv);
  for (const spec of AGENT_SPECS) ensureAgentStateDirs(paths.secrets, spec);

  console.log(`aos root      ${paths.root}`);
  console.log(`projects      ${paths.projects}`);
  console.log(`secrets       ${paths.secrets} (0700)`);
  console.log(`secrets env   ${paths.secretsEnv} (0600${created ? ", created from template" : ""})`);
  console.log(`agent logins  ${AGENT_NAMES.map((name) => `${paths.secrets}/${name}`).join(", ")}`);
}
