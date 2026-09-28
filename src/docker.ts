import { spawnSync } from "node:child_process";
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

/** The image's configured user ("uid:gid"), or undefined when the image is not built. */
export function imageUser(image = IMAGE): string | undefined {
  const result = docker(["image", "inspect", image, "--format", "{{.Config.User}}"]);
  return result.ok ? result.stdout : undefined;
}

export function assertImageMatchesHost(ids: HostIds, image = IMAGE): void {
  const user = imageUser(image);
  if (user === undefined) throw new AosError(`Image ${image} is not built. Run "aos image build" first.`);
  if (user !== `${ids.uid}:${ids.gid}`) {
    throw new AosError(
      `Image ${image} runs as ${user || "root"}, but this Mac user is ${ids.uid}:${ids.gid}. Run "aos image build" again.`,
    );
  }
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
