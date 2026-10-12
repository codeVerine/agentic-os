#!/usr/bin/env node
import { AGENT_NAMES, agentSpec, isAgentName } from "./agents.ts";
import { buildImage, hostIds } from "./docker.ts";
import { runDoctor } from "./doctor.ts";
import { AosError } from "./errors.ts";
import { replaceProcessEnv, sandcastleHostEnv } from "./hostenv.ts";
import { initRoot } from "./init.ts";
import { launchAgent } from "./launch.ts";
import { loginAgent } from "./login.ts";
import { aosPaths, aosRoot } from "./paths.ts";
import { worktreeCommand } from "./worktreeCli.ts";

const USAGE = `Usage: aos <command>

  aos init                          Create AOS_ROOT (default ~/AgenticOS) with secrets/ and an optional projects/
  aos doctor [--clean]              Check Docker, the aos-dev image, and per-agent secrets;
                                    --clean removes stopped aos containers left by older sessions
  aos image build [docker args]     Build the aos-dev:local image for this Mac user
  aos secrets login <agent> [args]  Run the agent's own login inside the container and keep it
  aos <agent> [args]                Lease a fresh treehouse worktree and open the agent's own
                                    interface in it (agents: ${AGENT_NAMES.join(", ")})
  aos <agent> --here [args]         Same, but run in the current directory with no worktree
  aos worktree <list|merge|rm|prune> [args]
                                    Manage this project's aos-leased worktrees; run without args
                                    for details

Agents run inside a Sandcastle Docker sandbox. Run agent commands from any
directory inside a git repository with at least one commit; arguments after
the agent name go to the agent CLI. Each launch gets its own git worktree from
the project's treehouse pool, on a fresh branch under aos/; an agent's own
resume/continue flags land back in the worktree that conversation belongs to.
"aos <agent> --here" skips worktrees and runs in the current repository.`;

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
    return launchAgent(agentSpec(command), rest, { paths, cwd: process.cwd(), hostEnv });
  }
  switch (command) {
    case "init":
      initRoot(paths);
      return 0;
    case "doctor": {
      const unknown = rest.filter((arg) => arg !== "--clean");
      if (unknown.length > 0) throw new AosError(`Usage: aos doctor [--clean]`);
      return runDoctor(paths, { clean: rest.includes("--clean") });
    }
    case "image": {
      const [sub, ...args] = rest;
      if (sub !== "build") throw new AosError(`Usage: aos image build [docker build args]`);
      return buildImage(hostIds(), args);
    }
    case "secrets": {
      const [sub, agent, ...args] = rest;
      if (sub !== "login" || agent === undefined) {
        throw new AosError(`Usage: aos secrets login <${AGENT_NAMES.join("|")}> [login args]`);
      }
      return loginAgent(agentSpec(agent), args, paths, hostEnv);
    }
    case "worktree":
      return worktreeCommand(rest, process.cwd(), paths);
    default:
      throw new AosError(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof AosError)) throw error;
  console.error(`aos: ${error.message}`);
  process.exitCode = 1;
}
