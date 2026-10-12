import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { AGENT_NAMES, AGENTS } from "./agents.ts";
import {
  contextHash,
  dockerEndpoint,
  dockerServerVersion,
  hostIds,
  IMAGE,
  imageConfig,
  imageProblem,
  leftoverContainers,
  removeContainers,
} from "./docker.ts";
import { AosError } from "./errors.ts";
import type { AosPaths } from "./paths.ts";
import { EMPTY_SECRETS, missingLoginFiles, readSecretsEnv, type SecretsEnv, selectAgentEnv, unroutedKeys } from "./secrets.ts";
import { treehouseVersion } from "./worktree.ts";

type Level = "ok" | "warn" | "fail";
const MARK: Record<Level, string> = { ok: "✓", warn: "!", fail: "✗" };

export function runDoctor(paths: AosPaths, options: { readonly clean?: boolean } = {}): number {
  let failed = false;
  const report = (level: Level, label: string, detail: string): void => {
    if (level === "fail") failed = true;
    console.log(`${MARK[level]} ${label.padEnd(10)} ${detail}`);
  };

  const rootOk = existsSync(paths.secrets);
  report(rootOk ? "ok" : "fail", "root", rootOk ? paths.root : `${paths.root} is not initialised: run "aos init"`);

  if (existsSync(paths.secrets)) {
    const mode = statSync(paths.secrets).mode & 0o777;
    report((mode & 0o077) === 0 ? "ok" : "fail", "secrets", `${paths.secrets} (mode ${mode.toString(8)})`);
  }

  let secrets: SecretsEnv = EMPTY_SECRETS;
  if (!existsSync(paths.secretsEnv)) {
    report("warn", "env file", `${paths.secretsEnv} is missing: run "aos init"`);
  } else {
    try {
      secrets = readSecretsEnv(paths.secretsEnv);
      const sections = [...secrets.perAgent.keys()].map((name) => `[${name}]`).join(" ");
      report("ok", "env file", `${paths.secretsEnv} (${secrets.shared.size} shared key${secrets.shared.size === 1 ? "" : "s"}${sections ? `, sections ${sections}` : ""})`);
      const unrouted = unroutedKeys(secrets, AGENT_NAMES.map((name) => AGENTS[name]));
      if (unrouted.length > 0) {
        report("warn", "env file", `not passed to any agent: ${unrouted.join(", ")} (move them under an [agent] section)`);
      }
    } catch (error) {
      if (!(error instanceof AosError)) throw error;
      report("fail", "env file", error.message);
    }
  }

  const docker = dockerServerVersion();
  const endpoint = dockerEndpoint();
  report(
    docker.version ? "ok" : "fail",
    "docker",
    docker.version ? `server ${docker.version} via ${endpoint}` : `unreachable via ${endpoint}: ${docker.error}`,
  );

  if (docker.version) {
    const config = imageConfig();
    const problem = imageProblem(config, hostIds(), contextHash());
    report(problem ? "fail" : "ok", "image", problem ?? `${IMAGE} (user ${config?.User})`);

    const leftovers = leftoverContainers();
    if (leftovers.length === 0) {
      report("ok", "containers", "no stopped aos containers");
    } else if (options.clean) {
      report("ok", "containers", `removed ${removeContainers(leftovers)} of ${leftovers.length} stopped aos containers`);
    } else {
      report("warn", "containers", `${leftovers.length} stopped aos container${leftovers.length === 1 ? "" : "s"} left over: run "aos doctor --clean" to remove`);
    }
  }

  const treehouse = treehouseVersion();
  report(
    treehouse ? "ok" : "warn",
    "treehouse",
    treehouse ? treehouse : `not found on PATH: install it from https://github.com/kunchenguid/treehouse, or always run "aos <agent> --here"`,
  );

  for (const name of AGENT_NAMES) {
    const spec = AGENTS[name];
    const agentDir = join(paths.secrets, name);
    const loggedIn = missingLoginFiles(spec, agentDir).length === 0;
    const keys = Object.keys(selectAgentEnv(spec, secrets));
    const parts = [loggedIn ? "login saved" : "no login", keys.length > 0 ? `keys ${keys.join(", ")}` : "no keys"];
    const ready = loggedIn || keys.length > 0;
    report(ready ? "ok" : "warn", name, ready ? parts.join("; ") : `${parts.join("; ")}: run "aos secrets login ${name}" or add a key to ${paths.secretsEnv}`);
  }

  return failed ? 1 : 0;
}
