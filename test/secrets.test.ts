import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { AGENTS } from "../src/agents.ts";
import {
  ENV_TEMPLATE,
  ensureAgentStateDirs,
  ensureSecretsEnvFile,
  missingLoginFiles,
  parseSecretsEnv,
  readSecretsEnv,
} from "../src/secrets.ts";
import { fileMode } from "./helpers.ts";

describe("parseSecretsEnv", () => {
  test("reads shared keys, comments, export prefixes and quotes", () => {
    const secrets = parseSecretsEnv(
      [
        "# comment",
        "",
        "OPENROUTER_API_KEY=sk-or-1",
        "export ANTHROPIC_API_KEY = sk-ant-2 ",
        `OPENAI_API_KEY="sk-openai=3"`,
        "GEMINI_API_KEY='g-4'",
        "EMPTY_KEY=",
      ].join("\n"),
    );
    assert.deepEqual(Object.fromEntries(secrets.shared), {
      OPENROUTER_API_KEY: "sk-or-1",
      ANTHROPIC_API_KEY: "sk-ant-2",
      OPENAI_API_KEY: "sk-openai=3",
      GEMINI_API_KEY: "g-4",
    });
    assert.equal(secrets.perAgent.size, 0);
  });

  test("assigns keys under an [agent] section to that agent only", () => {
    const secrets = parseSecretsEnv("A_KEY=shared\n[pi]\nROUTER_KEY=r1\n[ opencode ]\nROUTER_KEY=r2\n[pi]\nOTHER=o\n");
    assert.deepEqual(Object.fromEntries(secrets.shared), { A_KEY: "shared" });
    assert.deepEqual(Object.fromEntries(secrets.perAgent.get("pi") ?? []), { ROUTER_KEY: "r1", OTHER: "o" });
    assert.deepEqual(Object.fromEntries(secrets.perAgent.get("opencode") ?? []), { ROUTER_KEY: "r2" });
  });

  test("accepts CRLF line endings", () => {
    assert.equal(parseSecretsEnv("A=1\r\nB=2\r\n").shared.get("B"), "2");
  });

  test("strips inline comments from unquoted values only", () => {
    const secrets = parseSecretsEnv(
      [
        "OPENROUTER_API_KEY=sk-or-abc # personal",
        "GROQ_API_KEY=gsk#1\t# tab comment",
        `OPENAI_API_KEY="sk # kept" # dropped`,
        "GEMINI_API_KEY='g # kept'",
        "COMMENT_ONLY= # nothing here",
      ].join("\n"),
    );
    assert.deepEqual(Object.fromEntries(secrets.shared), {
      OPENROUTER_API_KEY: "sk-or-abc",
      GROQ_API_KEY: "gsk#1",
      OPENAI_API_KEY: "sk # kept",
      GEMINI_API_KEY: "g # kept",
    });
  });

  test("reports malformed lines with their line number", () => {
    assert.throws(() => parseSecretsEnv("A=1\nnot a pair", "env"), /env line 2: expected KEY=VALUE/);
    assert.throws(() => parseSecretsEnv("1BAD=x", "env"), /env line 1: "1BAD" is not a valid variable name/);
    assert.throws(() => parseSecretsEnv("[cursor]\nA=1", "env"), /env line 1: unknown section \[cursor\]/);
  });

  test("the init template parses to an empty file", () => {
    const secrets = parseSecretsEnv(ENV_TEMPLATE);
    assert.equal(secrets.shared.size, 0);
    assert.equal(secrets.perAgent.size, 0);
  });
});

describe("secrets files", () => {
  const dir = mkdtempSync(join(tmpdir(), "aos-secrets-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("a missing env file means no secrets", () => {
    assert.equal(readSecretsEnv(join(dir, "absent")).shared.size, 0);
  });

  test("refuses an env file other users can read", () => {
    const path = join(dir, "loose-env");
    writeFileSync(path, "A=1\n");
    chmodSync(path, 0o644);
    assert.throws(() => readSecretsEnv(path), /chmod 600/);
    chmodSync(path, 0o600);
    assert.equal(readSecretsEnv(path).shared.get("A"), "1");
  });

  test("init creates the env template with mode 0600 and never overwrites it", () => {
    const path = join(dir, "env");
    assert.equal(ensureSecretsEnvFile(path), true);
    assert.equal(fileMode(path), 0o600);
    writeFileSync(path, "KEPT=1\n");
    chmodSync(path, 0o640);
    assert.equal(ensureSecretsEnvFile(path), false);
    assert.equal(readFileSync(path, "utf8"), "KEPT=1\n");
    assert.equal(fileMode(path), 0o600);
  });

  test("agent state directories are created private, including subdirectories", () => {
    const agentDir = ensureAgentStateDirs(dir, AGENTS.opencode);
    assert.equal(fileMode(agentDir), 0o700);
    for (const sub of ["data", "config", "state"]) assert.equal(fileMode(join(agentDir, sub)), 0o700);
  });

  test("a login file only counts once it holds credentials", () => {
    const agentDir = ensureAgentStateDirs(dir, AGENTS.pi);
    assert.deepEqual(missingLoginFiles(AGENTS.pi, agentDir), ["auth.json"]);
    writeFileSync(join(agentDir, "auth.json"), "{}");
    assert.deepEqual(missingLoginFiles(AGENTS.pi, agentDir), ["auth.json"]);
    writeFileSync(join(agentDir, "auth.json"), `{"openrouter":{"type":"api_key"}}`);
    assert.deepEqual(missingLoginFiles(AGENTS.pi, agentDir), []);
  });
});
