import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import { AGENT_CLI_PINS, applyDockerfilePins, formatUpdatePlan } from "../src/imageUpdate.ts";

const base = realpathSync(mkdtempSync(join(tmpdir(), "aos-image-update-")));
after(() => rmSync(base, { recursive: true, force: true }));

describe("agent CLI pins", () => {
  test("every pin appears in docker/Dockerfile", () => {
    const dockerfile = readFileSync(join(fileURLToPath(new URL("../docker", import.meta.url)), "Dockerfile"), "utf8");
    for (const pin of AGENT_CLI_PINS) {
      assert.ok(dockerfile.includes(`${pin.pkg}@${pin.version}`), `${pin.pkg}@${pin.version} is not pinned in docker/Dockerfile`);
    }
  });

  test("applyDockerfilePins rewrites only the pinned tokens", () => {
    const dir = join(base, "docker");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "Dockerfile"),
      "RUN npm install -g \\\n    @openai/codex@0.158.0 \\\n    opencode-ai@1.18.33 \\\n",
    );
    applyDockerfilePins(new Map([["@openai/codex", "0.159.0"]]), dir);
    const updated = readFileSync(join(dir, "Dockerfile"), "utf8");
    assert.ok(updated.includes("@openai/codex@0.159.0"));
    assert.ok(updated.includes("opencode-ai@1.18.33"));
  });

  test("applyDockerfilePins fails loudly on a renamed package", () => {
    const dir = join(base, "docker-missing");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "Dockerfile"), "RUN npm install -g something-else@1.0.0\n");
    assert.throws(() => applyDockerfilePins(new Map([["@openai/codex", "0.159.0"]]), dir), /not pinned/);
  });

  test("formatUpdatePlan shows upgrades, up-to-date and offline states", () => {
    const plan = formatUpdatePlan([
      { pin: { pkg: "a", version: "1.0.0" }, latest: "1.1.0", updateAvailable: true },
      { pin: { pkg: "b", version: "2.0.0" }, latest: "2.0.0", updateAvailable: false },
      { pin: { pkg: "c", version: "3.0.0" }, latest: undefined, updateAvailable: false },
    ]);
    assert.match(plan, /a: 1\.0\.0 -> 1\.1\.0/);
    assert.match(plan, /b: 2\.0\.0 \(up to date\)/);
    assert.match(plan, /c: 3\.0\.0 \(could not check latest/);
  });
});
