import { findClaudeSessionOnHost, findCodexSessionOnHost } from "@ai-hero/sandcastle";
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { AgentName } from "./agents.ts";
import type { WorktreeRecord } from "./registry.ts";

/** Where an explicit session id's conversation lives, as far as aos can tell from the host. */
export type SessionLocation =
  | { readonly kind: "worktree"; readonly record: WorktreeRecord }
  | { readonly kind: "main-checkout" }
  | { readonly kind: "not-found" }
  | { readonly kind: "unsupported" };

/**
 * Whether this agent's own args ask it to resume or continue a prior conversation. Every agent
 * scopes that lookup to its current working directory (confirmed against each CLI: Claude's
 * `--resume`/`-c`/`--continue`, Codex's `resume` subcommand, OpenCode's `-c`/`--session`, Pi's
 * `-c`/`-r`/`--session[-id]`), so landing the launch in the right worktree is enough; aos does not
 * need to parse or track individual session ids.
 */
export function detectResumeIntent(agent: AgentName, args: readonly string[]): boolean {
  const has = (...flags: string[]): boolean => args.some((a) => flags.includes(flagName(a)));
  switch (agent) {
    case "claude":
      return has("-r", "--resume", "-c", "--continue");
    case "codex":
      return args[0] === "resume";
    case "opencode":
      return has("-c", "--continue", "-s", "--session");
    case "pi":
      return has("-c", "--continue", "-r", "--resume", "--session", "--session-id");
  }
}

/** A long option's name without any `=value`; any other argument unchanged. */
function flagName(arg: string): string {
  return arg.startsWith("--") ? arg.split("=", 1)[0]! : arg;
}

export function mostRecentlyUsed(records: readonly WorktreeRecord[], agent: AgentName): WorktreeRecord | undefined {
  return records.filter((r) => r.agent === agent).sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))[0];
}

/** The session id named on an explicit `--resume <id>` / `resume <id>` / `--session <id>` argument, if any. */
export function extractExplicitSessionId(agent: AgentName, args: readonly string[]): string | undefined {
  const valueAfter = (flag: string): string | undefined => {
    const i = args.findIndex((a) => flagName(a) === flag);
    if (i < 0) return undefined;
    const arg = args[i]!;
    const value = arg.length > flag.length ? arg.slice(flag.length + 1) : args[i + 1];
    return value !== undefined && value !== "" && !value.startsWith("-") ? value : undefined;
  };
  switch (agent) {
    case "claude":
      return valueAfter("--resume") ?? valueAfter("-r");
    case "codex":
      return args[0] === "resume" && args[1] !== undefined && !args[1].startsWith("-") ? args[1] : undefined;
    case "opencode":
      return valueAfter("-s") ?? valueAfter("--session");
    case "pi":
      return valueAfter("--session") ?? valueAfter("--session-id");
  }
}

/**
 * Finds which of this project's worktrees, or its own checkout (`mainSandboxName`, as used by
 * `--here` and by launches from before worktree support), holds a given session id, by searching that
 * agent's own history under its aos secrets/state directory on the host - the same place a launch
 * mounts into the container. Claude and Codex expose a host-side lookup from Sandcastle directly;
 * Pi's own session files live the same way (one directory per container cwd) but Sandcastle keeps
 * that lookup private, so aos re-implements the same directory scan here. OpenCode keeps sessions
 * in a single SQLite database with no documented per-session-id host index, so it is reported as
 * unsupported rather than guessed at.
 */
export async function findWorktreeForSession(
  agent: AgentName,
  sessionId: string,
  agentStateDir: string,
  records: readonly WorktreeRecord[],
  mainSandboxName: string,
): Promise<SessionLocation> {
  if (agent === "opencode") return { kind: "unsupported" };
  const containerDir = await sessionContainerDir(agent, sessionId, agentStateDir);
  if (containerDir === undefined) return { kind: "not-found" };
  const holds = (name: string): boolean => containerDir.includes(name.slice(-8));
  const record = records.find((r) => r.agent === agent && holds(r.sandboxName));
  if (record) return { kind: "worktree", record };
  return holds(mainSandboxName) ? { kind: "main-checkout" } : { kind: "not-found" };
}

/** The host-side trace of the container directory a session ran in: a directory name or a recorded cwd. */
async function sessionContainerDir(
  agent: Exclude<AgentName, "opencode">,
  sessionId: string,
  agentStateDir: string,
): Promise<string | undefined> {
  switch (agent) {
    case "claude": {
      const found = await findClaudeSessionOnHost(sessionId, join(agentStateDir, "projects")).catch(() => undefined);
      return found?.path ? basename(dirname(found.path)) : undefined;
    }
    case "codex": {
      const found = await findCodexSessionOnHost(sessionId, join(agentStateDir, "sessions")).catch(() => undefined);
      return found?.path ? await codexSessionCwd(found.path) : undefined;
    }
    case "pi":
      return findPiSessionFolder(join(agentStateDir, "sessions"), sessionId);
  }
}

/**
 * The `cwd` a Codex rollout file was recorded with, from its leading `session_meta` line's payload.
 * Streams only up to the first non-empty line: a rollout grows with the whole conversation.
 */
async function codexSessionCwd(filePath: string): Promise<string | undefined> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.trim() === "") continue;
      const parsed = JSON.parse(line) as { type?: unknown; payload?: { cwd?: unknown } };
      const cwd = parsed.type === "session_meta" ? parsed.payload?.cwd : undefined;
      return typeof cwd === "string" ? cwd : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** Pi session filenames end `_<id>.jsonl` under one directory per container cwd, like Claude's own layout. */
function findPiSessionFolder(sessionsDir: string, sessionId: string): string | undefined {
  if (!existsSync(sessionsDir)) return undefined;
  for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const files = readdirSync(join(sessionsDir, entry.name));
    if (files.some((f) => f.endsWith(`_${sessionId}.jsonl`))) return entry.name;
  }
  return undefined;
}
