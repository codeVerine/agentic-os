import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { AosError } from "./errors.ts";

const DOCKER_DIR = fileURLToPath(new URL("../docker", import.meta.url));

/** Agent CLIs pinned in docker/Dockerfile, kept in sync by test/imageUpdate.test.ts. */
export interface AgentCliPin {
  readonly pkg: string;
  readonly version: string;
}

export const AGENT_CLI_PINS: readonly AgentCliPin[] = [
  { pkg: "@anthropic-ai/claude-code", version: "2.1.283" },
  { pkg: "@openai/codex", version: "0.158.0" },
  { pkg: "opencode-ai", version: "1.18.33" },
  { pkg: "@earendil-works/pi-coding-agent", version: "0.87.1" },
];

export interface VersionCheck {
  readonly pin: AgentCliPin;
  readonly latest: string | undefined;
  readonly updateAvailable: boolean;
}

/** Latest published version of each pinned package via the host's npm (undefined when offline). */
export function checkLatestVersions(pins: readonly AgentCliPin[] = AGENT_CLI_PINS): VersionCheck[] {
  return pins.map((pin) => {
    const result = spawnSync("npm", ["view", `${pin.pkg}@latest`, "version"], { encoding: "utf8", timeout: 20_000 });
    const latest = result.error || result.status !== 0 ? undefined : result.stdout.trim() || undefined;
    return { pin, latest, updateAvailable: latest !== undefined && latest !== pin.version };
  });
}

export function formatUpdatePlan(checks: readonly VersionCheck[]): string {
  return checks
    .map((check) => {
      if (check.latest === undefined) return `${check.pin.pkg}: ${check.pin.version} (could not check latest: npm offline?)`;
      if (!check.updateAvailable) return `${check.pin.pkg}: ${check.pin.version} (up to date)`;
      return `${check.pin.pkg}: ${check.pin.version} -> ${check.latest}`;
    })
    .join("\n");
}

/**
 * Rewrites the pinned versions in docker/Dockerfile. Only touches the `pkg@version` tokens of
 * the global npm install, so agent renames still fail loudly instead of silently not updating.
 */
export function applyDockerfilePins(updates: ReadonlyMap<string, string>, dockerDir: string = DOCKER_DIR): void {
  const path = join(dockerDir, "Dockerfile");
  let content = readFileSync(path, "utf8");
  for (const [pkg, version] of updates) {
    const pattern = new RegExp(`(${escapeRegExp(pkg)})@[^\\s\\\\]+`);
    if (!pattern.test(content)) throw new AosError(`${pkg} is not pinned in ${path}; update the Dockerfile by hand.`);
    content = content.replace(pattern, `$1@${version}`);
  }
  writeFileSync(path, content);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function confirmPrompt(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}
