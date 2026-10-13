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
import { sandboxTuning } from "./hardening.ts";
import { hookRunnerProblems } from "./hookrunners.ts";
import { terminalEnv } from "./hostenv.ts";
import {
  type AosPaths,
  assertInitialised,
  assertProjectEnvNotLinked,
  gitCommonDir,
  locateProject,
  type ProjectLocation,
  sharedGitDirMount,
} from "./paths.ts";
import { projectKey } from "./registry.ts";
import { ensureAgentStateDirs, readSecretsEnv, selectAgentEnv } from "./secrets.ts";
import {
  createAnchorRepo,
  describeImport,
  HOST_REMOTE_NAME,
  readSessionHeadBranch,
  readSessionTip,
  type SessionGit,
  sessionGitMounts,
  syncSession,
  watchForChange,
} from "./sessiongit.ts";
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
    ? { hostRoot: project.root, sandboxName: project.sandboxName, branch: undefined, subdir: project.subdir }
    : await resolveWorktreeTarget(spec.name, agentArgs, project, paths, agentDir);
  if (here) {
    console.error(
      `aos: --here runs ${spec.name} in your own checkout with read-write access to your real .git: ` +
        `an agent's config, hooks, refs or remote changes run on the Mac on your next git command. ` +
        `Use "aos ${spec.name}" (worktree mode) for anything you would not run on the Mac directly.`,
    );
  }

  assertProjectEnvNotLinked(target.hostRoot);

  // Sandcastle bind-mounts every project at the same /home/agent/workspace.
  // Agents key transcripts, trust and memory by working directory, so the agent
  // runs from a second, per-project mount of the same host directory instead.
  const sandboxProjectRoot = `${SANDBOX_PROJECTS_DIR}/${target.sandboxName}`;
  await spec.trustProject?.(agentDir, sandboxProjectRoot);
  const workdir = containerWorkdir(sandboxProjectRoot, target.hostRoot, target.subdir);
  const setup = spec.launchSetup ? `${spec.launchSetup} && ` : "";
  const { session } = target;
  const key = projectKey(project.root);
  const commonDir = gitCommonDir(project.root);
  if (session) {
    const problems = hookRunnerProblems({ commonDir, worktreePath: target.hostRoot, sessionHooksDir: join(session.gitDir, "hooks") });
    for (const problem of problems) console.error(`aos: ${problem}`);
  }
  // A worktree session mounts its own git directory instead of the shared one, so that is what git must trust.
  const sharedGitDir = sharedGitDirMount(target.hostRoot);
  const safeDirectories = session
    ? [sandboxProjectRoot, session.gitDir]
    : sharedGitDir === undefined
      ? [sandboxProjectRoot]
      : [sandboxProjectRoot, sharedGitDir];
  // The session's git directory has a `host` remote for the repository's own branches; fetching it gives the
  // agent the Mac's local and unpushed branches as host/<branch> before it starts.
  const fetchHost = session ? `(git fetch -q ${HOST_REMOTE_NAME} >/dev/null 2>&1 || true) && ` : "";
  const argv = ["sh", "-c", `cd "$1" && shift && ${fetchHost}${setup}exec "$@"`, "aos", workdir, spec.command, ...agentArgs];

  mkdirSync(paths.run, { recursive: true });
  const runDir = mkdtempSync(join(paths.run, `${spec.name}-`));
  const markerPath = launchMarkerPath(runDir);
  const spoolDir = mkdtempSync(join(paths.run, "github-"));
  const anchorDir = session ? mkdtempSync(join(paths.run, "anchor-")) : undefined;
  const containerSpoolDir = `${markerPath}/github`;
  const finish = cleanupOnExit(() => {
    removeLaunchContainers(markerPath);
    rmSync(runDir, { recursive: true, force: true });
    rmSync(spoolDir, { recursive: true, force: true });
    if (anchorDir) rmSync(anchorDir, { recursive: true, force: true });
  });
  const launchScopedMounts = spec.launchScopedDirs.map((sandboxPath) => {
    const hostPath = join(runDir, basename(sandboxPath));
    mkdirSync(hostPath);
    return { hostPath, sandboxPath };
  });

  const github = prepareGithubAccess({
    secrets,
    repoRoot: target.hostRoot,
    pinFile: join(paths.githubRepos, `${key}.json`),
    spoolDir,
    containerSpoolDir,
    tokensDir: paths.githubTokens,
    notify: (message) => console.error(`aos: ${message}`),
  });

  const preCommitCache = join(paths.preCommitCache, key);
  mkdirSync(preCommitCache, { recursive: true });

  const tuning = sandboxTuning(options.hostEnv);
  const sandbox = docker({
    imageName: IMAGE,
    containerUid: ids.uid,
    containerGid: ids.gid,
    ...(tuning.network !== undefined ? { network: tuning.network } : {}),
    ...(tuning.cpus !== undefined ? { cpus: tuning.cpus } : {}),
    mounts: [
      ...(session
        ? sessionGitMounts(commonDir, session, target.hostRoot, sandboxProjectRoot)
        : [{ hostPath: target.hostRoot, sandboxPath: sandboxProjectRoot }]),
      { hostPath: preCommitCache, sandboxPath: `${SANDBOX_HOME}/.cache/pre-commit` },
      ...spec.stateMounts.map((mount) => ({
        hostPath: mount.subdir ? join(agentDir, mount.subdir) : agentDir,
        sandboxPath: mount.sandboxPath,
      })),
      ...launchScopedMounts,
      { hostPath: runDir, sandboxPath: markerPath },
      { hostPath: spoolDir, sandboxPath: containerSpoolDir },
    ],
  });

  const sync =
    session && target.branch
      ? startSessionSync({ paths, key, commonDir, worktreePath: target.hostRoot, session, branch: target.branch, scratchDir: runDir })
      : undefined;
  try {
    const result = await interactive({
      name: `aos ${spec.name} (${project.name}${target.branch ? ` @ ${target.branch}` : ""})`,
      agent: interactiveProvider(spec, argv),
      sandbox,
      // A worktree session's own git directory is mounted by aos, so Sandcastle gets an empty repository
      // of its own instead of the project's, whose git directory it would mount read-write.
      cwd: anchorDir ? createAnchorRepo(anchorDir) : target.hostRoot,
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
    await sync?.finish();
    github.stop();
    finish();
  }
}

interface SessionSyncOptions {
  readonly paths: AosPaths;
  readonly key: string;
  readonly commonDir: string;
  readonly worktreePath: string;
  readonly session: SessionGit;
  /** The session branch the agent's commits go to. */
  readonly branch: string;
  readonly scratchDir: string;
}

/**
 * Imports the session branch into the repository about a second after each agent commit, and once more
 * when the session ends. Nothing is printed while the agent's terminal is up; what went wrong or was
 * left behind is reported when the session is over.
 */
function startSessionSync(options: SessionSyncOptions): { finish: () => Promise<void> } {
  const { session, branch } = options;
  let lastError: string | undefined;
  let divertedNote: string | undefined;
  const importNow = async (): Promise<void> => {
    try {
      const { outcome } = await syncSession(options);
      lastError = undefined;
      if (outcome.kind === "imported" && outcome.diverged) divertedNote = describeImport(outcome, branch);
    } catch (error) {
      lastError = (error as Error).message;
    }
  };
  const live = watchForChange({ read: () => readSessionTip(session, branch), run: importNow });
  return {
    finish: async () => {
      await live.stop();
      await importNow();
      if (lastError) {
        console.error(`aos: could not import the session's commits: ${lastError}`);
        console.error(`aos: they are safe in ${session.gitDir}. Run "aos worktree merge ${session.id}" to import and merge them.`);
      }
      if (divertedNote) console.error(`aos: ${divertedNote}`);
      const head = readSessionHeadBranch(session);
      if (head !== "" && head !== branch) {
        console.error(`aos: the session ended on branch ${head}; only ${branch} was imported, so commits on ${head} stay in the session.`);
      }
    },
  };
}

function assertCommittedGitRepo(project: ProjectLocation): void {
  if (gitOrEmpty(project.root, "rev-parse", "--verify", "--quiet", "HEAD") === "") {
    throw new AosError(`Project ${project.name} has no commits yet. Sandcastle needs one: make a first commit in ${project.root}.`);
  }
}
