import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { launchMarkerPath, leftoverContainers, removeContainers, removeLaunchContainers } from "../src/docker.ts";

// A fake docker on PATH records every call and answers `ps` from FAKE_DOCKER_PS, so the cleanup
// commands can be checked without a Docker daemon.
const base = realpathSync(mkdtempSync(join(tmpdir(), "aos-containers-")));
after(() => rmSync(base, { recursive: true, force: true }));

const binDir = join(base, "bin");
const callLog = join(base, "docker.log");
mkdirSync(binDir);
writeFileSync(
  join(binDir, "docker"),
  `#!/bin/sh
echo "$@" >> "${callLog}"
case "$1" in
  ps) printf '%s' "$FAKE_DOCKER_PS" ;;
  rm) shift; for arg in "$@"; do case "$arg" in -*) ;; *) echo "$arg" ;; esac; done
    if [ -n "$FAKE_DOCKER_RM_ERROR" ]; then echo "$FAKE_DOCKER_RM_ERROR" >&2; exit 1; fi ;;
esac
`,
);
chmodSync(join(binDir, "docker"), 0o755);
process.env.PATH = `${binDir}:${process.env.PATH}`;

function calls(): string[] {
  return existsSync(callLog) ? readFileSync(callLog, "utf8").trim().split("\n") : [];
}

beforeEach(() => {
  rmSync(callLog, { force: true });
  delete process.env.FAKE_DOCKER_PS;
  delete process.env.FAKE_DOCKER_RM_ERROR;
});

describe("launchMarkerPath", () => {
  test("is unique per run directory and independent of its parent", () => {
    assert.equal(launchMarkerPath("/Users/me/AgenticOS/run/pi-AbC123"), "/mnt/aos-launch/pi-AbC123");
    assert.notEqual(launchMarkerPath("/run/pi-AbC123"), launchMarkerPath("/run/pi-XyZ789"));
  });
});

describe("removeLaunchContainers", () => {
  test("force-removes exactly the containers that mount the launch marker", () => {
    process.env.FAKE_DOCKER_PS = "aaa111\nbbb222\n";
    removeLaunchContainers("/mnt/aos-launch/pi-AbC123");
    assert.deepEqual(calls(), ["ps -aq --no-trunc --filter volume=/mnt/aos-launch/pi-AbC123", "rm -f aaa111 bbb222"]);
  });

  test("removes nothing when the container is already gone", () => {
    process.env.FAKE_DOCKER_PS = "";
    removeLaunchContainers("/mnt/aos-launch/pi-AbC123");
    assert.deepEqual(calls(), ["ps -aq --no-trunc --filter volume=/mnt/aos-launch/pi-AbC123"]);
  });
});

describe("leftoverContainers", () => {
  test("lists only stopped sandcastle containers of the aos image", () => {
    process.env.FAKE_DOCKER_PS = "dead01\nexit02\n";
    assert.deepEqual(leftoverContainers("aos-dev:local"), ["dead01", "exit02"]);
    assert.deepEqual(calls(), [
      "ps -aq --no-trunc --filter ancestor=aos-dev:local --filter name=^sandcastle- --filter status=exited --filter status=dead",
    ]);
  });

  test("removeContainers removes the listed ids without force and reports how many went", () => {
    assert.deepEqual(removeContainers(["dead01", "exit02"]), { removed: 2 });
    assert.deepEqual(calls(), ["rm dead01 exit02"]);
    assert.deepEqual(removeContainers([]), { removed: 0 });
  });

  test("removeContainers surfaces docker's error when a removal fails", () => {
    process.env.FAKE_DOCKER_RM_ERROR = "Error: No such container: exit02";
    assert.deepEqual(removeContainers(["dead01", "exit02"]), { removed: 2, error: "Error: No such container: exit02" });
  });
});

describe("cleanupOnExit", () => {
  const exitModule = new URL("../src/exit.ts", import.meta.url).href;

  // Registers the cleanup in a child process, then lets the child end the way the case names.
  const run = (marker: string, ending: string) =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { appendFileSync } from "node:fs";
         import { cleanupOnExit } from ${JSON.stringify(exitModule)};
         const release = cleanupOnExit(() => appendFileSync(${JSON.stringify(marker)}, "cleaned\\n"));
         ${ending}`,
      ],
      { encoding: "utf8", timeout: 20_000 },
    );

  const cleanedCount = (marker: string): number =>
    existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").length : 0;

  for (const [signal, code] of [
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    test(`runs the cleanup once when ${signal} ends the process`, () => {
      const marker = join(base, `cleaned-${signal}`);
      const result = run(marker, `process.kill(process.pid, "${signal}"); setTimeout(() => {}, 10_000);`);
      assert.equal(result.status, code);
      assert.equal(cleanedCount(marker), 1);
    });
  }

  test("runs the cleanup when the process exits on its own with a failure", () => {
    const marker = join(base, "cleaned-exit");
    const result = run(marker, "process.exitCode = 3;");
    assert.equal(result.status, 3);
    assert.equal(cleanedCount(marker), 1);
  });

  test("runs the cleanup once when released early, and not again at exit", () => {
    const marker = join(base, "cleaned-released");
    const result = run(marker, "release();");
    assert.equal(result.status, 0);
    assert.equal(cleanedCount(marker), 1);
  });
});
