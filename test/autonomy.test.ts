import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { AGENT_NAMES, AGENTS } from "../src/agents.ts";
import { applyDefaults, fillMissing } from "../src/defaults.ts";
import { trustCodexProject } from "../src/trust.ts";
import { fileMode } from "./helpers.ts";

describe("fillMissing", () => {
  test("adds absent keys and leaves the rest alone", () => {
    const { merged, changed } = fillMissing({ theme: "dark" }, { permissions: { defaultMode: "bypassPermissions" } });
    assert.deepEqual(merged, { theme: "dark", permissions: { defaultMode: "bypassPermissions" } });
    assert.equal(changed, true);
  });

  test("fills only the missing keys of an object the user already has", () => {
    const { merged, changed } = fillMissing(
      { permissions: { allow: ["Bash(ls)"] } },
      { permissions: { defaultMode: "bypassPermissions" } },
    );
    assert.deepEqual(merged, { permissions: { allow: ["Bash(ls)"], defaultMode: "bypassPermissions" } });
    assert.equal(changed, true);
  });

  test("never changes a value the user set, whatever its type", () => {
    const defaults = { permission: { "*": "allow" }, skip: true };
    for (const existing of [
      { permission: { "*": "ask" }, skip: false },
      { permission: "ask", skip: false },
      { permission: null, skip: false },
    ]) {
      const { merged, changed } = fillMissing(existing, defaults);
      assert.deepEqual(merged, existing);
      assert.equal(changed, false);
    }
  });
});

describe("applyDefaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "aos-defaults-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const defaults = { file: "settings.json", values: { defaultProjectTrust: "always" } };

  test("creates a missing file with mode 0600", () => {
    const agentDir = join(dir, "create");
    mkdirSync(agentDir);
    applyDefaults(agentDir, defaults);
    assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")), { defaultProjectTrust: "always" });
    assert.equal(fileMode(join(agentDir, "settings.json")), 0o600);
  });

  test("keeps the user's settings and their choices, and stays stable across launches", () => {
    const agentDir = join(dir, "keep");
    mkdirSync(agentDir);
    const path = join(agentDir, "settings.json");
    writeFileSync(path, JSON.stringify({ defaultModel: "m", defaultProjectTrust: "ask" }));
    applyDefaults(agentDir, defaults);
    applyDefaults(agentDir, defaults);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { defaultModel: "m", defaultProjectTrust: "ask" });

    writeFileSync(path, JSON.stringify({ defaultModel: "m" }));
    applyDefaults(agentDir, defaults);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { defaultModel: "m", defaultProjectTrust: "always" });
  });

  test("refuses to touch a file that is not a JSON object", () => {
    const agentDir = join(dir, "bad");
    mkdirSync(agentDir);
    const path = join(agentDir, "settings.json");
    writeFileSync(path, "{ // comment\n}");
    assert.throws(() => applyDefaults(agentDir, defaults), /settings\.json is not valid JSON/);
    writeFileSync(path, "[]");
    assert.throws(() => applyDefaults(agentDir, defaults), /must hold a JSON object/);
    assert.equal(readFileSync(path, "utf8"), "[]");
  });
});

describe("trustCodexProject", () => {
  const dir = mkdtempSync(join(tmpdir(), "aos-trust-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const root = "/home/agent/projects/demo";

  test("writes the entry Codex saves when its trust prompt is accepted", async () => {
    const home = join(dir, "fresh");
    mkdirSync(home);
    await trustCodexProject(home, root);
    const path = join(home, "config.toml");
    assert.equal(readFileSync(path, "utf8"), `[projects."${root}"]\ntrust_level = "trusted"\n`);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  test("appends after the user's config without touching it, once per project", async () => {
    const home = join(dir, "existing");
    mkdirSync(home);
    const path = join(home, "config.toml");
    writeFileSync(path, 'model = "gpt-6"\n\n[tui]\nnotifications = true');
    await trustCodexProject(home, root);
    await trustCodexProject(home, root);
    await trustCodexProject(home, `${root}-2`);
    assert.equal(
      readFileSync(path, "utf8"),
      [
        'model = "gpt-6"',
        "",
        "[tui]",
        "notifications = true",
        "",
        `[projects."${root}"]`,
        'trust_level = "trusted"',
        "",
        `[projects."${root}-2"]`,
        'trust_level = "trusted"',
        "",
      ].join("\n"),
    );
  });

  test("leaves a config that already mentions the project alone", async () => {
    const home = join(dir, "mentioned");
    mkdirSync(home);
    const path = join(home, "config.toml");
    const content = `[projects."${root}"]\ntrust_level = "untrusted"\n`;
    writeFileSync(path, content);
    await trustCodexProject(home, root);
    assert.equal(readFileSync(path, "utf8"), content);
  });
});

describe("agent autonomy defaults", () => {
  test("Claude Code starts in bypass-permissions mode without its warning dialog or trust prompt", () => {
    assert.deepEqual(AGENTS.claude.autonomyDefaults, [
      {
        file: "settings.json",
        values: { permissions: { defaultMode: "bypassPermissions" }, skipDangerousModePermissionPrompt: true },
      },
    ]);
    assert.equal(AGENTS.claude.launchEnv.CLAUDE_CODE_SANDBOXED, "1");
  });

  test("OpenCode allows everything from the lowest layer of its global config", () => {
    assert.deepEqual(AGENTS.opencode.autonomyDefaults, [
      { file: "config/config.json", values: { permission: { "*": "allow" } } },
    ]);
  });

  test("Pi loads project resources without asking", () => {
    assert.deepEqual(AGENTS.pi.autonomyDefaults, [{ file: "settings.json", values: { defaultProjectTrust: "always" } }]);
  });

  test("Codex takes its defaults from the image, and only its project trust from aos", () => {
    assert.deepEqual(AGENTS.codex.autonomyDefaults, []);
    assert.equal(AGENTS.codex.trustProject, trustCodexProject);
  });

  test("default files are relative paths inside the agent's login directory", () => {
    for (const name of AGENT_NAMES) {
      for (const { file } of AGENTS[name].autonomyDefaults) {
        assert.match(file, /^[A-Za-z0-9][A-Za-z0-9._/-]*$/);
        assert.ok(!file.split("/").includes(".."));
      }
    }
  });
});
