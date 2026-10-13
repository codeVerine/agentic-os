import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { AGENT_SPECS } from "./agents.ts";
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
import { githubSetup } from "./github.ts";
import type { AosPaths } from "./paths.ts";
import { EMPTY_SECRETS, missingLoginFiles, readSecretsEnv, type SecretsEnv, selectAgentEnv, unroutedKeys } from "./secrets.ts";
import { guardConfigPath, guardFileIntact } from "./guard.ts";
import { describeTuning, sandboxTuning } from "./hardening.ts";
import { isSupportedTreehouseVersion, resolveTreehouseCmd, TREEHOUSE_MIN_VERSION, TREEHOUSE_PINNED_VERSION, treehouseLocation, treehouseVersion } from "./treehouse.ts";

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
      const unrouted = unroutedKeys(secrets, AGENT_SPECS);
      if (unrouted.length > 0) {
        report("warn", "env file", `not passed to any agent: ${unrouted.join(", ")} (move them under an [agent] section)`);
      }
    } catch (error) {
      if (!(error instanceof AosError)) throw error;
      report("fail", "env file", error.message);
    }
  }

  const github = githubSetup(secrets);
  if (github.state === "ready") {
    report("ok", "github", `App ${github.config.appId}, key ${github.config.keyFile}; agents get a token for their project's origin repository`);
  } else if (github.state === "invalid") {
    report("fail", "github", github.problem);
  } else {
    report("warn", "github", `not configured: containers get no GitHub credentials. Run "aos github setup" (README, "GitHub access")`);
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
      const removal = removeContainers(leftovers);
      const summary = `removed ${removal.removed} of ${leftovers.length} stopped aos containers`;
      report(removal.error ? "warn" : "ok", "containers", removal.error ? `${summary}: ${removal.error}` : summary);
    } else {
      report("warn", "containers", `${leftovers.length} stopped aos container${leftovers.length === 1 ? "" : "s"} left over: run "aos doctor --clean" to remove`);
    }
  }

  const treehouseCmd = resolveTreehouseCmd();
  const treehouse = treehouseVersion(treehouseCmd);
  const source = treehouseLocation(treehouseCmd).source;
  const where = source === "vendored" ? `${treehouseCmd} (vendored)` : source === "env" ? `${treehouseCmd} (AOS_TREEHOUSE_CMD)` : "on PATH";
  if (!treehouse) {
    report("warn", "treehouse", `not found: run "aos treehouse install" to install pinned ${TREEHOUSE_PINNED_VERSION} into ${paths.bin}, or always run "aos <agent> --here"`);
  } else if (!isSupportedTreehouseVersion(treehouse)) {
    report("warn", "treehouse", `${treehouse} via ${where}: older than minimum ${TREEHOUSE_MIN_VERSION}; run "aos treehouse install --force"`);
  } else {
    report("ok", "treehouse", `${treehouse} via ${where}`);
  }

  if (guardFileIntact(paths)) {
    report("ok", "guard", `snippet ready (${guardConfigPath(paths)}); run "aos guard install" inside each project checkout to enable it`);
  } else {
    report("warn", "guard", `snippet missing: run "aos init", then "aos guard install" inside each project checkout`);
  }

  try {
    const tuned = describeTuning(sandboxTuning());
    report("ok", "tuning", tuned ?? "defaults (set AOS_NETWORK and/or AOS_CPUS to constrain sessions)");
  } catch (error) {
    if (!(error instanceof AosError)) throw error;
    report("fail", "tuning", error.message);
  }

  for (const spec of AGENT_SPECS) {
    const { name } = spec;
    const agentDir = join(paths.secrets, name);
    const loggedIn = missingLoginFiles(spec, agentDir).length === 0;
    const keys = Object.keys(selectAgentEnv(spec, secrets));
    const parts = [loggedIn ? "login saved" : "no login", keys.length > 0 ? `keys ${keys.join(", ")}` : "no keys"];
    const ready = loggedIn || keys.length > 0;
    report(ready ? "ok" : "warn", name, ready ? parts.join("; ") : `${parts.join("; ")}: run "aos secrets login ${name}" or add a key to ${paths.secretsEnv}`);
  }

  return failed ? 1 : 0;
}
