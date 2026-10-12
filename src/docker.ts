import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AosError } from "./errors.ts";

export const IMAGE = "aos-dev:local";
export const DOCKER_CONTEXT_DIR = fileURLToPath(new URL("../docker", import.meta.url));

export interface HostIds {
  readonly uid: number;
  readonly gid: number;
}

export function hostIds(): HostIds {
  if (!process.getuid || !process.getgid) throw new AosError("aos needs a POSIX host (macOS or Linux).");
  return { uid: process.getuid(), gid: process.getgid() };
}

function docker(args: readonly string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.error) return { ok: false, stdout: "", stderr: result.error.message };
  return { ok: result.status === 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

export function dockerServerVersion(): { version?: string; error?: string } {
  const result = docker(["version", "--format", "{{.Server.Version}}"]);
  return result.ok ? { version: result.stdout } : { error: result.stderr || "docker version failed" };
}

/** Where the docker CLI connects, for diagnostics: DOCKER_HOST or the current context's endpoint. */
export function dockerEndpoint(): string {
  if (process.env.DOCKER_HOST) return `DOCKER_HOST=${process.env.DOCKER_HOST}`;
  const result = docker(["context", "inspect", "--format", "{{.Name}} ({{.Endpoints.docker.Host}})"]);
  return result.ok ? `context ${result.stdout}` : "default endpoint";
}

const CONTEXT_HASH_LABEL = "aos.context-hash";

/**
 * Hash of the files in the image build context, stamped on the image so a stale build is detected.
 * Skips hidden files and editor backups, which docker/.dockerignore also keeps out of the build.
 */
export function contextHash(dir = DOCKER_CONTEXT_DIR): string {
  const hash = createHash("sha256");
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || entry.name.startsWith(".") || entry.name.endsWith("~")) continue;
    hash.update(`${entry.name}\0`).update(readFileSync(join(dir, entry.name))).update("\0");
  }
  return hash.digest("hex");
}

export interface ImageConfig {
  readonly User?: string;
  readonly Labels?: Readonly<Record<string, string>> | null;
}

/** The image's configuration, or undefined when the image is not built. */
export function imageConfig(image = IMAGE): ImageConfig | undefined {
  const result = docker(["image", "inspect", image, "--format", "{{json .Config}}"]);
  return result.ok ? (JSON.parse(result.stdout) as ImageConfig) : undefined;
}

/** Why the image cannot be used, with the fix, or undefined when it matches this host and aos version. */
export function imageProblem(
  config: ImageConfig | undefined,
  ids: HostIds,
  expectedHash: string,
  image = IMAGE,
): string | undefined {
  if (config === undefined) return `Image ${image} is not built. Run "aos image build" first.`;
  const user = config.User ?? "";
  if (user !== `${ids.uid}:${ids.gid}`) {
    return `Image ${image} runs as ${user || "root"}, but this Mac user is ${ids.uid}:${ids.gid}. Run "aos image build" again.`;
  }
  if (config.Labels?.[CONTEXT_HASH_LABEL] !== expectedHash) {
    return `Image ${image} was built from a different version of aos's docker/ directory. Run "aos image build" again.`;
  }
  return undefined;
}

export function assertImageMatchesHost(ids: HostIds, image = IMAGE): void {
  const problem = imageProblem(imageConfig(image), ids, contextHash(), image);
  if (problem) throw new AosError(problem);
}

export function buildImage(ids: HostIds, extraArgs: readonly string[]): number {
  const result = spawnSync(
    "docker",
    [
      "build",
      "--build-arg",
      `AGENT_UID=${ids.uid}`,
      "--build-arg",
      `AGENT_GID=${ids.gid}`,
      "--label",
      `${CONTEXT_HASH_LABEL}=${contextHash()}`,
      "-t",
      IMAGE,
      ...extraArgs,
      DOCKER_CONTEXT_DIR,
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw new AosError(`docker build failed to start: ${result.error.message}`);
  return result.status ?? 1;
}

const LAUNCH_MARKER_DIR = "/mnt/aos-launch";

/**
 * Container path a launch mounts its private run directory at. Sandcastle names its containers
 * itself and does not expose the name, but the mount destination is unique to one launch, so it
 * identifies exactly that launch's container.
 */
export function launchMarkerPath(runDir: string): string {
  return `${LAUNCH_MARKER_DIR}/${basename(runDir)}`;
}

/** Force-removes the container, running or stopped, that mounts `markerPath`. Synchronous so it can run in an exit handler. */
export function removeLaunchContainers(markerPath: string): void {
  const found = docker(["ps", "-aq", "--no-trunc", "--filter", `volume=${markerPath}`]);
  const ids = found.ok ? found.stdout.split("\n").filter(Boolean) : [];
  if (ids.length > 0) docker(["rm", "-f", ...ids]);
}

/** Stopped containers started from the aos image by Sandcastle, left behind by sessions that could not clean up. */
export function leftoverContainers(image = IMAGE): string[] {
  const result = docker([
    "ps",
    "-aq",
    "--no-trunc",
    "--filter",
    `ancestor=${image}`,
    "--filter",
    "name=^sandcastle-",
    "--filter",
    "status=exited",
    "--filter",
    "status=dead",
    "--filter",
    "status=created",
  ]);
  return result.ok ? result.stdout.split("\n").filter(Boolean) : [];
}

/** Removes the given containers; returns how many docker confirmed removing. */
export function removeContainers(ids: readonly string[]): number {
  if (ids.length === 0) return 0;
  const result = docker(["rm", ...ids]);
  return result.stdout.split("\n").filter(Boolean).length;
}
