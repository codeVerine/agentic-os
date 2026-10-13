import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { interactive } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { type AgentSpec, interactiveProvider } from "./agents.ts";
import { applyDefaults } from "./defaults.ts";
import { assertImageMatchesHost, hostIds, IMAGE, launchMarkerPath, removeLaunchContainers, SANDBOX_HOME } from "./docker.ts";
import { AosError } from "./errors.ts";
import { cleanupOnExit } from "./exit.ts";
import { gitOrEmpty, safeDirectoryEnv } from "./git.ts";
import { prepareGithubAccess } from "./github.ts";
import { terminalEnv } from "./hostenv.ts";
import {
  type AosPaths,
  assertInitialised,
  assertProjectEnvNotLinked,
  locateProject,
  type ProjectLocation,
  sharedGitDirMount,
} from "./paths.ts";
import { ensureAgentStateDirs, readSecretsEnv, selectAgentEnv } from "./secrets.ts";
import { containerWorkdir, resolveWorktreeTarget } from "./worktree.ts";

const SANDBOX_PROJECTS_DIR = `${SANDBOX_HOME}/projects`;

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
  assertInitialised(paths);
  const ids = hostIds();
  assertImageMatchesHost(ids);

  const agentDir = ensureAgentStateDirs(paths.secrets, spec);
  for (const defaults of spec.autonomyDefaults) applyDefaults(agentDir, defaults);
  const secrets = readSecretsEnv(paths.secretsEnv);

  const target = here
    ? { hostRoot: project.root, sandboxName: project.sandboxName, branch: undefined }
    : await resolveWorktreeTarget(spec.name, agentArgs, project, paths, agentDir);

  assertProjectEnvNotLinked(target.hostRoot);

  // Sandcastle bind-mounts every project at the same /home/agent/workspace.
  // Agents key transcripts, trust and memory by working directory, so the agent
  // runs from a second, per-project mount of the same host directory instead.
  const sandboxProjectRoot = `${SANDBOX_PROJECTS_DIR}/${target.sandboxName}`;
  await spec.trustProject?.(agentDir, sandboxProjectRoot);
  const sharedGitDir = sharedGitDirMount(target.hostRoot);
  const safeDirectories = sharedGitDir === undefined ? [sandboxProjectRoot] : [sandboxProjectRoot, sharedGitDir];
  const workdir = containerWorkdir(sandboxProjectRoot, target.hostRoot, project.subdir);
  const setup = spec.launchSetup ? `${spec.launchSetup} && ` : "";
  const argv = ["sh", "-c", `cd "$1" && shift && ${setup}exec "$@"`, "aos", workdir, spec.command, ...agentArgs];

  mkdirSync(paths.run, { recursive: true });
  const runDir = mkdtempSync(join(paths.run, `${spec.name}-`));
  const markerPath = launchMarkerPath(runDir);
  const spoolDir = mkdtempSync(join(paths.run, "github-"));
  const containerSpoolDir = `${markerPath}/github`;
  const finish = cleanupOnExit(() => {
    removeLaunchContainers(markerPath);
    rmSync(runDir, { recursive: true, force: true });
    rmSync(spoolDir, { recursive: true, force: true });
  });
  const launchScopedMounts = spec.launchScopedDirs.map((sandboxPath) => {
    const hostPath = join(runDir, basename(sandboxPath));
    mkdirSync(hostPath);
    return { hostPath, sandboxPath };
  });

  const github = prepareGithubAccess({
    secrets,
    repoRoot: target.hostRoot,
    spoolDir,
    containerSpoolDir,
    tokensDir: paths.githubTokens,
    notify: (message) => console.error(`aos: ${message}`),
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
      { hostPath: runDir, sandboxPath: markerPath },
      { hostPath: spoolDir, sandboxPath: containerSpoolDir },
    ],
  });

  try {
    const result = await interactive({
      name: `aos ${spec.name} (${project.name}${target.branch ? ` @ ${target.branch}` : ""})`,
      agent: interactiveProvider(spec, argv, paths.sessions),
      sandbox,
      cwd: target.hostRoot,
      branchStrategy: { type: "head" },
      env: {
        ...terminalEnv(options.hostEnv),
        ...spec.configEnv,
        ...spec.launchEnv,
        ...selectAgentEnv(spec, secrets),
        ...github.env,
        ...safeDirectoryEnv(safeDirectories),
      },
    });
    return result.exitCode;
  } finally {
    github.stop();
    finish();
  }
}

function assertCommittedGitRepo(project: ProjectLocation): void {
  if (gitOrEmpty(project.root, "rev-parse", "--verify", "--quiet", "HEAD") === "") {
    throw new AosError(`Project ${project.name} has no commits yet. Sandcastle needs one: make a first commit in ${project.root}.`);
  }
}
