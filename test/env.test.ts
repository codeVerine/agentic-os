import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { AGENT_NAMES, AGENTS } from "../src/agents.ts";
import { dockerEndpointEnv, sandcastleHostEnv, terminalEnv } from "../src/hostenv.ts";
import { parseSecretsEnv, selectAgentEnv, unroutedKeys } from "../src/secrets.ts";

describe("selectAgentEnv", () => {
  const secrets = parseSecretsEnv(
    [
      "ANTHROPIC_API_KEY=ant",
      "CLAUDE_CODE_OAUTH_TOKEN=oauth",
      "OPENAI_API_KEY=oai",
      "OPENROUTER_API_KEY=or",
      "OPENCODE_API_KEY=zen",
      "[pi]",
      "TOKENROUTER_API_KEY=tr",
      "OPENROUTER_API_KEY=or-pi",
    ].join("\n"),
  );

  test("claude gets only Anthropic credentials", () => {
    assert.deepEqual(selectAgentEnv(AGENTS.claude, secrets), {
      ANTHROPIC_API_KEY: "ant",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    });
  });

  test("codex gets OpenAI and OpenRouter keys", () => {
    assert.deepEqual(selectAgentEnv(AGENTS.codex, secrets), { OPENAI_API_KEY: "oai", OPENROUTER_API_KEY: "or" });
  });

  test("opencode gets the provider and router keys but not the claude subscription token", () => {
    assert.deepEqual(selectAgentEnv(AGENTS.opencode, secrets), {
      ANTHROPIC_API_KEY: "ant",
      OPENAI_API_KEY: "oai",
      OPENROUTER_API_KEY: "or",
      OPENCODE_API_KEY: "zen",
    });
  });

  test("an [agent] section adds keys for that agent and overrides shared values", () => {
    assert.deepEqual(selectAgentEnv(AGENTS.pi, secrets), {
      ANTHROPIC_API_KEY: "ant",
      OPENAI_API_KEY: "oai",
      OPENROUTER_API_KEY: "or-pi",
      OPENCODE_API_KEY: "zen",
      TOKENROUTER_API_KEY: "tr",
    });
    for (const name of AGENT_NAMES.filter((agent) => agent !== "pi")) {
      assert.equal(selectAgentEnv(AGENTS[name], secrets).TOKENROUTER_API_KEY, undefined, name);
    }
  });

  test("shared keys no agent knows are reported", () => {
    const withTypo = parseSecretsEnv("OPENROUTER_API_KEY=or\nOPENROUTR_API_KEY=typo\n[pi]\nCUSTOM=1\n");
    assert.deepEqual(unroutedKeys(withTypo, AGENT_NAMES.map((name) => AGENTS[name])), ["OPENROUTR_API_KEY"]);
  });
});

describe("sandcastleHostEnv", () => {
  const hostEnv = {
    PATH: "/usr/bin",
    HOME: "/Users/me",
    LANG: "en_US.UTF-8",
    LC_CTYPE: "UTF-8",
    DOCKER_HOST: "unix:///tmp/docker.sock",
    ANTHROPIC_API_KEY: "host-secret",
    GH_TOKEN: "host-gh",
    SSH_AUTH_SOCK: "/tmp/ssh.sock",
    GIT_DIR: "/elsewhere/.git",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/host/hooks",
  };

  test("keeps what docker needs and drops host secrets and git overrides", () => {
    const env = sandcastleHostEnv(hostEnv, "/nonexistent-home");
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.HOME, "/Users/me");
    assert.equal(env.LC_CTYPE, "UTF-8");
    assert.equal(env.DOCKER_HOST, "unix:///tmp/docker.sock");
    for (const key of ["ANTHROPIC_API_KEY", "GH_TOKEN", "SSH_AUTH_SOCK", "GIT_DIR"]) assert.equal(env[key], undefined, key);
  });

  test("disables repository hooks and fsmonitor for host git", () => {
    const env = sandcastleHostEnv(hostEnv, "/nonexistent-home");
    assert.deepEqual(
      {
        count: env.GIT_CONFIG_COUNT,
        pairs: [
          [env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_VALUE_0],
          [env.GIT_CONFIG_KEY_1, env.GIT_CONFIG_VALUE_1],
        ],
      },
      {
        count: "2",
        pairs: [
          ["core.hooksPath", "/dev/null"],
          ["core.fsmonitor", "false"],
        ],
      },
    );
  });
});

describe("dockerEndpointEnv", () => {
  const home = mkdtempSync(join(tmpdir(), "aos-home-"));
  after(() => rmSync(home, { recursive: true, force: true }));
  const noDefaultSocket = join(home, "no-default.sock");
  mkdirSync(join(home, ".docker", "run"), { recursive: true });
  writeFileSync(join(home, ".docker", "run", "docker.sock"), "");

  test("points at the Docker Desktop socket when nothing else selects an endpoint", () => {
    assert.deepEqual(dockerEndpointEnv({}, home, noDefaultSocket), {
      DOCKER_HOST: `unix://${join(home, ".docker", "run", "docker.sock")}`,
    });
  });

  test("leaves an explicit DOCKER_HOST, DOCKER_CONTEXT or default socket alone", () => {
    assert.deepEqual(dockerEndpointEnv({ DOCKER_HOST: "tcp://x" }, home, noDefaultSocket), {});
    assert.deepEqual(dockerEndpointEnv({ DOCKER_CONTEXT: "colima" }, home, noDefaultSocket), {});
    assert.deepEqual(dockerEndpointEnv({}, home, join(home, ".docker", "run", "docker.sock")), {});
  });

  test("leaves the docker CLI's current context alone", () => {
    const configDir = join(home, "cfg");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ currentContext: "orbstack" }));
    assert.deepEqual(dockerEndpointEnv({ DOCKER_CONFIG: configDir }, home, noDefaultSocket), {});
  });
});

describe("terminalEnv", () => {
  test("uses a TERM the image has terminfo for and forwards terminal hints", () => {
    assert.deepEqual(terminalEnv({ TERM: "xterm-ghostty", COLORTERM: "truecolor", TERM_PROGRAM: "ghostty", SECRET: "x" }), {
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "ghostty",
    });
  });
});
