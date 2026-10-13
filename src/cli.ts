#!/usr/bin/env node
import { AGENT_NAMES, AGENTS, agentSpec, isAgentName } from "./agents.ts";
import { buildImage, hostIds } from "./docker.ts";
import { runDoctor } from "./doctor.ts";
import { AosError } from "./errors.ts";
import { replaceProcessEnv, sandcastleHostEnv } from "./hostenv.ts";
import { setupGithubApp } from "./githubSetup.ts";
import { initRoot } from "./init.ts";
import { launchAgent } from "./launch.ts";
import { loginAgent } from "./login.ts";
import { aosPaths, aosRoot } from "./paths.ts";
import { installTreehouse, parseTreehouseInstallArgs, TREEHOUSE_PINNED_VERSION } from "./treehouse.ts";
import { applyDockerfilePins, checkLatestVersions, confirmPrompt, formatUpdatePlan } from "./imageUpdate.ts";
import { guardStatus, installGuard, removeGuard } from "./guard.ts";
import { applyProtectionRuleset, parseRepoSlug } from "./ruleset.ts";
import { mainCheckout } from "./git.ts";
import { locateProject } from "./paths.ts";
import { worktreeCommand } from "./worktreeCli.ts";

const USAGE = `Usage: aos <command>

  aos init                            Create AOS_ROOT (default ~/AgenticOS) with secrets/ and an
                                      optional projects/
  aos doctor [--clean]                Check Docker, the aos-dev image, and per-agent secrets;
                                      --clean removes stopped aos containers left by older sessions
  aos image build [docker build args] Build the aos-dev:local image for this Mac user
  aos image update [--check] [--yes]
                                       Check for newer agent CLIs, show what would change,
                                       and rebuild the image after confirmation
  aos guard <install|remove|status>    Pause hooks/fsmonitor on the Mac while an aos/* branch
                                       is checked out (one includeIf line in this repo)
  aos treehouse install [--force] [--version=X]
                                       Install pinned treehouse (${TREEHOUSE_PINNED_VERSION}) into
                                       AOS_ROOT/bin for aos worktrees
  aos secrets login <agent> [args]    Run the agent's own login inside the container and keep it
  aos github setup [--force]          Create the GitHub App that gives agents pull, push and PR access
                                       (one confirmation click in the browser), save its key, check
                                       the install; --force replaces an existing configuration
  aos github ruleset <owner/repo> [--dry-run]
                                       Block force pushes and branch deletion on all branches
                                       (uses your own gh auth; the App cannot do this itself)
  aos <agent> [args]                  Lease a fresh treehouse worktree and open the agent's own
                                      interface in it (agents: ${AGENT_NAMES.join(", ")})
  aos <agent> --here [args]           Same, but run in the current directory with no worktree
                                       (unprotected: the agent can write your real .git)
  aos worktree <list|merge|rm|prune> [args]
                                      Manage this project's aos-leased worktrees; run without args
                                      for details

Agents run inside a Sandcastle Docker sandbox. Run agent commands from any
directory inside a git repository with at least one commit; arguments after
the agent name go to the agent CLI. Each launch gets its own git worktree from
aos's own treehouse pool, on a fresh branch under aos/ with a private git directory
the agent's commits are imported from; an agent's own resume/continue flags land
back in the worktree that conversation belongs to. "aos <agent> --here" skips
worktrees and runs in the current repository, with no git protection.`;

async function main(argv: readonly string[]): Promise<number> {
  const hostEnv = { ...process.env };
  const paths = aosPaths(aosRoot(hostEnv));
  replaceProcessEnv(sandcastleHostEnv(hostEnv));

  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command === undefined ? 1 : 0;
  }
  if (isAgentName(command)) {
    return launchAgent(AGENTS[command], rest, { paths, cwd: process.cwd(), hostEnv });
  }
  switch (command) {
    case "init":
      initRoot(paths);
      return 0;
    case "treehouse": {
      const [sub, ...flags] = rest;
      if (sub !== "install") throw new AosError('Usage: aos treehouse install [--force] [--version=X]');
      const { force, version: requested } = parseTreehouseInstallArgs(flags);
      const version = requested ?? TREEHOUSE_PINNED_VERSION;
      const { path, fresh } = installTreehouse({ binDir: paths.bin, version, force });
      console.log(fresh ? `treehouse ${version} installed to ${path}` : `treehouse ${version} already present at ${path}`);
      return 0;
    }
    case "doctor": {
      const unknown = rest.filter((arg) => arg !== "--clean");
      if (unknown.length > 0) throw new AosError("Usage: aos doctor [--clean]");
      return runDoctor(paths, { clean: rest.includes("--clean") });
    }
    case "image": {
      const [sub, ...args] = rest;
      if (sub === "build") return buildImage(hostIds(), args);
      if (sub === "update") return imageUpdate(args);
      throw new AosError("Usage: aos image build [docker build args] | aos image update [--check] [--yes]");
    }
    case "secrets": {
      const [sub, agent, ...args] = rest;
      if (sub !== "login" || agent === undefined) {
        throw new AosError(`Usage: aos secrets login <${AGENT_NAMES.join("|")}> [login args]`);
      }
      return loginAgent(agentSpec(agent), args, paths, hostEnv);
    }
    case "github": {
      const [sub, ...flags] = rest;
      if (sub === "setup") {
        const unknown = flags.filter((arg) => arg !== "--force");
        if (unknown.length > 0) throw new AosError("Usage: aos github setup [--force]");
        return setupGithubApp({ paths, force: flags.includes("--force"), hostEnv });
      }
      if (sub === "ruleset") {
        const dryRun = flags.includes("--dry-run");
        const positionals = flags.filter((arg) => arg !== "--dry-run");
        if (positionals.length !== 1 || positionals[0] === undefined) throw new AosError("Usage: aos github ruleset <owner/repo> [--dry-run]");
        applyProtectionRuleset(parseRepoSlug(positionals[0]), dryRun);
        if (!dryRun) console.log(`aos: force pushes and deletions are now blocked in ${positionals[0]}.`);
        return 0;
      }
      throw new AosError("Usage: aos github setup [--force] | aos github ruleset <owner/repo> [--dry-run]");
    }
    case "worktree":
      return worktreeCommand(rest, process.cwd(), paths);
    case "guard": {
      const [sub] = rest;
      if (sub !== "install" && sub !== "remove" && sub !== "status" && sub !== undefined) {
        throw new AosError("Usage: aos guard <install|remove|status>");
      }
      const mainRoot = mainCheckout(locateProject(process.cwd()).root);
      if (sub === "install") {
        const snippet = installGuard(paths, mainRoot);
        console.log(`aos: host git in ${mainRoot} now pauses hooks and fsmonitor while an aos/* branch is checked out (${snippet}).`);
        return 0;
      }
      if (sub === "remove") {
        removeGuard(mainRoot);
        console.log(`aos: removed the host git guard for aos/* branches in ${mainRoot}.`);
        return 0;
      }
      if (sub === "status" || sub === undefined) {
        const status = guardStatus(paths, mainRoot);
        if (status.state === "ok") console.log(`aos: guard installed in ${mainRoot} (${status.path}).`);
        else if (status.state === "shadowed") console.log(`aos: guard in ${mainRoot} is unseated by a later ${status.key}: run "aos guard install" to restore it.`);
        else if (status.state === "points-elsewhere") console.log(`aos: guard in ${mainRoot} points at ${status.path}, not this root. Run "aos guard install" to repoint it.`);
        else console.log('aos: guard not installed here. Run "aos guard install" to pause hooks while an aos/* branch is checked out.');
        return status.state === "ok" ? 0 : 1;
      }
    }
    default:
      throw new AosError(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

async function imageUpdate(args: readonly string[]): Promise<number> {
  const checkOnly = args.includes("--check");
  const assumeYes = args.includes("--yes");
  const unknown = args.filter((arg) => arg !== "--check" && arg !== "--yes");
  if (unknown.length > 0) throw new AosError("Usage: aos image update [--check] [--yes]");
  const checks = checkLatestVersions();
  console.log(formatUpdatePlan(checks));
  const updates = new Map(checks.filter((c) => c.updateAvailable).map((c) => [c.pin.pkg, c.latest as string]));
  if (updates.size === 0) {
    console.log("aos: agent CLIs are at their pinned versions.");
    return 0;
  }
  if (checkOnly) return 0;
  if (!assumeYes && !(await confirmPrompt(`Update ${updates.size} agent CLI pin${updates.size === 1 ? "" : "s"} and rebuild aos-dev:local?`))) {
    console.log("aos: leaving the Dockerfile unchanged.");
    return 0;
  }
  applyDockerfilePins(updates);
  return buildImage(hostIds(), []);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof AosError)) throw error;
  console.error(`aos: ${error.message}`);
  process.exitCode = 1;
}
