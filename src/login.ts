import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { AgentSpec } from "./agents.ts";
import { assertImageMatchesHost, hostIds, IMAGE, SANDBOX_HOME } from "./docker.ts";
import { AosError } from "./errors.ts";
import { terminalEnv } from "./hostenv.ts";
import { type AosPaths, assertInitialised } from "./paths.ts";
import { ensureAgentStateDirs, missingLoginFiles } from "./secrets.ts";

/**
 * Runs the agent's own login flow in a throwaway aos-dev container whose only
 * mounts are the agent's state directories, so the resulting login is stored
 * in secrets/<agent>/ and shared by every project.
 */
export function loginAgent(spec: AgentSpec, loginArgs: readonly string[], paths: AosPaths, hostEnv: NodeJS.ProcessEnv): number {
  assertInitialised(paths);
  const ids = hostIds();
  assertImageMatchesHost(ids);
  const agentDir = ensureAgentStateDirs(paths.secrets, spec);

  const containerEnv = { ...terminalEnv(hostEnv), ...spec.configEnv };
  const args = [
    "run",
    "--rm",
    process.stdin.isTTY ? "-it" : "-i",
    "--name",
    `aos-login-${spec.name}-${randomBytes(4).toString("hex")}`,
    "--user",
    `${ids.uid}:${ids.gid}`,
    "--workdir",
    SANDBOX_HOME,
    ...Object.keys(containerEnv).flatMap((key) => ["--env", key]),
    ...spec.stateMounts.flatMap((mount) => [
      "--mount",
      `type=bind,src=${mount.subdir ? join(agentDir, mount.subdir) : agentDir},dst=${mount.sandboxPath}`,
    ]),
    "--entrypoint",
    spec.command,
    IMAGE,
    ...spec.loginCommand,
    ...(loginArgs.length > 0 ? loginArgs : spec.loginDefaultArgs),
  ];

  console.error(`aos: logging in ${spec.name} inside ${IMAGE}; login state is saved in ${agentDir}`);
  if (loginArgs.length === 0) console.error(`aos: ${spec.loginHint}`);
  const result = spawnSync("docker", args, { stdio: "inherit", env: { ...process.env, ...containerEnv } });
  if (result.error) throw new AosError(`docker run failed to start: ${result.error.message}`);

  const missing = missingLoginFiles(spec, agentDir);
  if (missing.length === 0) console.error(`aos: ${spec.name} login saved in ${agentDir}`);
  else console.error(`aos: no ${spec.name} login found yet (missing ${missing.join(", ")} in ${agentDir})`);
  return result.status ?? 1;
}
