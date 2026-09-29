import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { interactive } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { type AgentSpec, interactiveProvider } from "./agents.ts";
import { applyDefaults } from "./defaults.ts";
import { assertImageMatchesHost, hostIds, IMAGE } from "./docker.ts";
import { AosError } from "./errors.ts";
import { terminalEnv } from "./hostenv.ts";
import { type AosPaths, locateProject, type ProjectLocation } from "./paths.ts";
import { ensureAgentStateDirs, readSecretsEnv, selectAgentEnv } from "./secrets.ts";
import { resolveWorktreeTarget } from "./worktree.ts";

const SANDBOX_PROJECTS_DIR = "/home/agent/projects";

export interface LaunchOptions {
  readonly paths: AosPaths;
  readonly cwd: string;
  /** The host environment aos was started with, before it was scrubbed. */
  readonly hostEnv: NodeJS.ProcessEnv;
}

export async function launchAgent(spec: AgentSpec, rawArgs: readonly string[], options: LaunchOptions): Promise<number> {
  const { paths } = options;
  const here = rawArgs.includes("--here");
  const agentArgs = rawArgs.filter((arg) => arg !== "--here");
  const project = locateProject(options.cwd);
  assertCommittedGitRepo(project);
  if (!existsSync(paths.secrets)) throw new AosError(`${paths.secrets} does not exist. Run "aos init" first.`);
  const ids = hostIds();
  assertImageMatchesHost(ids);

  const agentDir = ensureAgentStateDirs(paths.secrets, spec);
  for (const defaults of spec.autonomyDefaults) applyDefaults(agentDir, defaults);
  const secrets = readSecretsEnv(paths.secretsEnv);

  const target = here
    ? { hostRoot: project.root, sandboxName: project.sandboxName, branch: undefined }
    : await resolveWorktreeTarget(spec.name, agentArgs, project, paths, agentDir);

  // Sandcastle bind-mounts every project at the same /home/agent/workspace.
  // Agents key transcripts, trust and memory by working directory, so the agent
  // runs from a second, per-project mount of the same host directory instead.
  const sandboxProjectRoot = `${SANDBOX_PROJECTS_DIR}/${target.sandboxName}`;
  spec.trustProject?.(agentDir, sandboxProjectRoot);
  const workdir = project.subdir ? `${sandboxProjectRoot}/${project.subdir}` : sandboxProjectRoot;
  const setup = spec.launchSetup ? `${spec.launchSetup} && ` : "";
  const argv = ["sh", "-c", `cd "$1" && shift && ${setup}exec "$@"`, "aos", workdir, spec.command, ...agentArgs];

  mkdirSync(paths.run, { recursive: true });
  const runDir = mkdtempSync(join(paths.run, `${spec.name}-`));
  const launchScopedMounts = spec.launchScopedDirs.map((sandboxPath) => {
    const hostPath = join(runDir, basename(sandboxPath));
    mkdirSync(hostPath);
    return { hostPath, sandboxPath };
  });

  const sandbox = docker({
    imageName: IMAGE,
    containerUid: ids.uid,
    containerGid: ids.gid,
    mounts: [
      { hostPath: target.hostRoot, sandboxPath: sandboxProjectRoot },
      ...spec.stateMounts.map((mount) => ({
        hostPath: mount.subdir ? join(agentDir, mount.subdir) : agentDir,
        sandboxPath: mount.sandboxPath,
      })),
      ...launchScopedMounts,
    ],
  });

  try {
    const result = await interactive({
      name: `aos ${spec.name} (${project.name}${target.branch ? ` @ ${target.branch}` : ""})`,
      agent: interactiveProvider(spec, argv, paths.sessions),
      sandbox,
      cwd: target.hostRoot,
      branchStrategy: { type: "head" },
      env: { ...terminalEnv(options.hostEnv), ...spec.configEnv, ...spec.launchEnv, ...selectAgentEnv(spec, secrets) },
    });
    return result.exitCode;
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
}

function assertCommittedGitRepo(project: ProjectLocation): void {
  const head = spawnSync("git", ["-C", project.root, "rev-parse", "--verify", "--quiet", "HEAD"], { encoding: "utf8" });
  if (head.status !== 0) {
    throw new AosError(`Project ${project.name} has no commits yet. Sandcastle needs one: make a first commit in ${project.root}.`);
  }
}
