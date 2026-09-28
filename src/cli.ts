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

const USAGE = `Usage: aos <command>

  aos init                          Create AOS_ROOT (default ~/AgenticOS) with secrets/ and an optional projects/
  aos doctor                        Check Docker, the aos-dev image, and per-agent secrets
  aos image build [docker args]     Build the aos-dev:local image for this Mac user
  aos secrets login <agent> [args]  Run the agent's own login inside the container and keep it
  aos <agent> [args]                Open the agent's own interface for the current project
                                    (agents: ${AGENT_NAMES.join(", ")})

Agents run inside a Sandcastle Docker sandbox. Run agent commands from any git
project directory (not your home directory or a parent of it); arguments after
the agent name go to the agent CLI.`;

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
    case "doctor":
      return runDoctor(paths);
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
