import { join } from "node:path";
import { claudeCode, codex, opencode, pi, type AgentProvider } from "@ai-hero/sandcastle";
import type { DefaultsFile } from "./defaults.ts";
import { SANDBOX_HOME } from "./docker.ts";
import { AosError } from "./errors.ts";
import { trustCodexProject } from "./trust.ts";

export const AGENT_NAMES = ["claude", "codex", "opencode", "pi"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

/** A directory under secrets/<agent>/ mounted into the container at `sandboxPath`. */
export interface StateMount {
  readonly subdir: string;
  readonly sandboxPath: string;
}

export interface AgentSpec {
  readonly name: AgentName;
  /** Executable of the agent CLI inside the aos-dev image. */
  readonly command: string;
  readonly stateMounts: readonly StateMount[];
  /**
   * Sandbox directories inside the shared state that hold per-process runtime
   * files (pids, sockets). Each launch mounts fresh empty ones over them so
   * concurrent containers never see each other's pids from another namespace.
   */
  readonly launchScopedDirs: readonly string[];
  /** Non-secret environment that points the agent at its mounted state. */
  readonly configEnv: Readonly<Record<string, string>>;
  /** Shell command run in the container before the agent starts, only for `aos <agent>` launches. */
  readonly launchSetup?: string;
  /** Environment for `aos <agent>` launches only, on top of configEnv. */
  readonly launchEnv: Readonly<Record<string, string>>;
  /** Marks the project trusted in the agent's state, given the project root in the container. */
  readonly trustProject?: (agentDir: string, sandboxProjectRoot: string) => void;
  /**
   * Full-autonomy defaults for agents whose config has no lower layer than the
   * user's own file: aos fills these keys into that file when they are absent, and
   * never changes a key the user set. Codex needs none, its defaults live in the
   * image's /etc/codex/config.toml, below the user's config.toml.
   */
  readonly autonomyDefaults: readonly DefaultsFile[];
  /** Keys from the shared secrets env file this agent can use. */
  readonly envKeys: readonly string[];
  /** Files under secrets/<agent>/ that exist once the agent's own login has completed. */
  readonly loginFiles: readonly string[];
  /** Agent subcommand that starts its login flow; extra `aos secrets login` args are appended. */
  readonly loginCommand: readonly string[];
  /** Appended to loginCommand when `aos secrets login` gets no extra args. */
  readonly loginDefaultArgs: readonly string[];
  readonly loginHint: string;
}

const ANTHROPIC_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"];
const OPENAI_KEYS = ["OPENAI_API_KEY", "OPENAI_BASE_URL"];
const ROUTER_KEYS = ["OPENROUTER_API_KEY", "OPENCODE_API_KEY", "AI_GATEWAY_API_KEY"];
const OTHER_PROVIDER_KEYS = [
  "CEREBRAS_API_KEY",
  "DEEPSEEK_API_KEY",
  "FIREWORKS_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GROQ_API_KEY",
  "HF_TOKEN",
  "KIMI_API_KEY",
  "MISTRAL_API_KEY",
  "MOONSHOT_API_KEY",
  "NVIDIA_API_KEY",
  "TOGETHER_API_KEY",
  "XAI_API_KEY",
  "ZAI_API_KEY",
];

export const AGENTS: Readonly<Record<AgentName, AgentSpec>> = {
  claude: {
    name: "claude",
    command: "claude",
    stateMounts: [{ subdir: "", sandboxPath: `${SANDBOX_HOME}/.claude` }],
    launchScopedDirs: [],
    // Without CLAUDE_CONFIG_DIR, Claude Code keeps .claude.json in $HOME, outside the mount.
    configEnv: { CLAUDE_CONFIG_DIR: `${SANDBOX_HOME}/.claude` },
    // Claude Code asks "Do you trust this folder?" for every new project directory. This
    // variable, which Claude Code sets for its own sandboxed runners, marks the workspace
    // trusted. The image and every project mount are already the sandbox.
    launchEnv: { CLAUDE_CODE_SANDBOXED: "1" },
    autonomyDefaults: [
      {
        file: "settings.json",
        values: { permissions: { defaultMode: "bypassPermissions" }, skipDangerousModePermissionPrompt: true },
      },
    ],
    envKeys: [...ANTHROPIC_KEYS, "CLAUDE_CODE_OAUTH_TOKEN"],
    loginFiles: [".credentials.json"],
    loginCommand: ["auth", "login"],
    loginDefaultArgs: [],
    loginHint: "Open the printed URL on the Mac, sign in with the Claude subscription, and paste the code back here.",
  },
  codex: {
    name: "codex",
    command: "codex",
    stateMounts: [{ subdir: "", sandboxPath: `${SANDBOX_HOME}/.codex` }],
    // Codex's shared background server keeps its pid files here and a symlink to
    // its socket in the container's /tmp; neither is meaningful to another container.
    launchScopedDirs: [`${SANDBOX_HOME}/.codex/app-server-daemon`, `${SANDBOX_HOME}/.codex/app-server-control`],
    configEnv: { CODEX_HOME: `${SANDBOX_HOME}/.codex` },
    // Codex refreshes its rotating ChatGPT tokens under an in-process lock only;
    // this local server serializes refreshes across containers (docker/codex-refresh.mjs).
    launchSetup: "node /usr/local/lib/aos/codex-refresh.mjs",
    launchEnv: { CODEX_REFRESH_TOKEN_URL_OVERRIDE: "http://127.0.0.1:48123/oauth/token" },
    trustProject: trustCodexProject,
    autonomyDefaults: [],
    envKeys: [...OPENAI_KEYS, "CODEX_API_KEY", "OPENROUTER_API_KEY"],
    loginFiles: ["auth.json"],
    loginCommand: ["login"],
    loginDefaultArgs: ["--device-auth"],
    loginHint:
      "Open the printed URL on the Mac and enter the code to sign in with the ChatGPT (Codex) subscription.",
  },
  opencode: {
    name: "opencode",
    command: "opencode",
    stateMounts: [
      { subdir: "data", sandboxPath: `${SANDBOX_HOME}/.local/share/opencode` },
      { subdir: "config", sandboxPath: `${SANDBOX_HOME}/.config/opencode` },
      { subdir: "state", sandboxPath: `${SANDBOX_HOME}/.local/state/opencode` },
    ],
    launchScopedDirs: [],
    configEnv: {},
    launchEnv: {},
    // OpenCode merges config.json, then opencode.json, then opencode.jsonc from its config
    // directory, later files winning. aos owns config.json, so the user's own opencode.json(c) overrides it.
    autonomyDefaults: [{ file: "config/config.json", values: { permission: { "*": "allow" } } }],
    envKeys: [...ANTHROPIC_KEYS, ...OPENAI_KEYS, ...ROUTER_KEYS, ...OTHER_PROVIDER_KEYS],
    loginFiles: ["data/auth.json"],
    loginCommand: ["auth", "login"],
    loginDefaultArgs: [],
    loginHint: "Pick the provider (OpenCode Zen or Go for the OpenCode subscription) and follow its prompts.",
  },
  pi: {
    name: "pi",
    command: "pi",
    stateMounts: [{ subdir: "", sandboxPath: `${SANDBOX_HOME}/.pi/agent` }],
    launchScopedDirs: [],
    configEnv: { PI_CODING_AGENT_DIR: `${SANDBOX_HOME}/.pi/agent` },
    launchEnv: {},
    // Pi runs tools without asking. Its one prompt is "Trust project folder?", shown when a
    // project has .pi settings, extensions or skills; "always" loads them without asking.
    autonomyDefaults: [{ file: "settings.json", values: { defaultProjectTrust: "always" } }],
    envKeys: [...ANTHROPIC_KEYS, "ANTHROPIC_OAUTH_TOKEN", ...OPENAI_KEYS, ...ROUTER_KEYS, ...OTHER_PROVIDER_KEYS],
    loginFiles: ["auth.json"],
    loginCommand: [],
    loginDefaultArgs: [],
    loginHint: "Pi logs in from its own interface: type /login, pick the provider, and follow its prompts. Quit with Ctrl+C twice.",
  },
};

export const AGENT_SPECS: readonly AgentSpec[] = AGENT_NAMES.map((name) => AGENTS[name]);

export function isAgentName(value: string): value is AgentName {
  return (AGENT_NAMES as readonly string[]).includes(value);
}

export function agentSpec(name: string): AgentSpec {
  if (!isAgentName(name)) {
    throw new AosError(`Unknown agent "${name}". Expected one of: ${AGENT_NAMES.join(", ")}.`);
  }
  return AGENTS[name];
}

/**
 * Sandcastle's built-in providers always pass `--model`, which would skip the
 * agent's own model picker. aos keeps the provider (for its session storage
 * settings) and replaces only the interactive argv, so the agent starts exactly
 * as it does when typed on the host.
 */
export function interactiveProvider(
  spec: AgentSpec,
  argv: readonly string[],
  sessionsDir: string,
): AgentProvider {
  const hostSessionsDir = join(sessionsDir, spec.name);
  const base = sandcastleProvider(spec.name, hostSessionsDir);
  return { ...base, buildInteractiveArgs: () => [...argv] };
}

function sandcastleProvider(name: AgentName, hostSessionsDir: string): AgentProvider {
  // The model argument is unused: buildInteractiveArgs is replaced above.
  switch (name) {
    case "claude":
      return claudeCode("default", {
        sessionStorage: {
          hostProjectsDir: hostSessionsDir,
          sandboxProjectsDir: `${SANDBOX_HOME}/.claude/projects`,
        },
      });
    case "codex":
      return codex("default", {
        sessionStorage: { hostSessionsDir, sandboxSessionsDir: `${SANDBOX_HOME}/.codex/sessions` },
      });
    case "pi":
      return pi("default", {
        sessionStorage: { hostSessionsDir, sandboxSessionsDir: `${SANDBOX_HOME}/.pi/agent/sessions` },
      });
    case "opencode":
      return opencode("default");
  }
}
