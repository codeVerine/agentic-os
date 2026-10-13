import type { AgentName } from "../../src/agents.ts";
import { aosPaths, locateProject } from "../../src/paths.ts";
import { resolveWorktreeTarget } from "../../src/worktree.ts";

// A stand-in for one `aos <agent> --continue` process: resolves its worktree, prints the outcome as
// one JSON line, then stays alive like a running agent until the test kills it.
const [cwd, agent, aosRoot, agentDir, ...agentArgs] = process.argv.slice(2) as [string, AgentName, string, string, ...string[]];

try {
  const target = await resolveWorktreeTarget(agent, agentArgs, locateProject(cwd), aosPaths(aosRoot), agentDir);
  console.log(JSON.stringify({ ok: true, ...target }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: (error as Error).message }));
}
setInterval(() => {}, 1000);
