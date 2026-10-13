import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, mock, test } from "node:test";
import { AGENT_SPECS, interactiveProvider } from "../src/agents.ts";
import { initRoot } from "../src/init.ts";
import { aosPaths } from "../src/paths.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "aos-init-")));
after(() => rmSync(base, { recursive: true, force: true }));

describe("initRoot", () => {
  test("creates the secrets, but no state/sessions directory that nothing writes to", () => {
    const root = join(base, "root");
    mock.method(console, "log", () => {});
    try {
      initRoot(aosPaths(root));
    } finally {
      mock.restoreAll();
    }
    assert.equal(existsSync(join(root, "secrets", "env")), true);
    assert.equal(existsSync(join(root, "state", "sessions")), false);
  });
});

describe("interactiveProvider", () => {
  test("starts every agent with exactly the launch argv", () => {
    const argv = ["sh", "-c", "exec \"$@\"", "aos", "/home/agent/projects/app-1a2b3c4d", "agent", "--flag"];
    for (const spec of AGENT_SPECS) {
      const provider = interactiveProvider(spec, argv);
      assert.deepEqual(provider.buildInteractiveArgs?.({ prompt: "", dangerouslySkipPermissions: false }), argv, spec.name);
    }
  });
});
