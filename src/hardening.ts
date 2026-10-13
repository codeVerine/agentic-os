import { AosError } from "./errors.ts";

/**
 * Opt-in container tuning, off by default. Sandcastle's Docker provider only exposes a subset
 * of `docker run` flags (network, cpus, ...), so this plumbs exactly what it supports today:
 * `AOS_NETWORK` (one network, or several comma-separated) detaches sessions from the default
 * bridge (which on Docker Desktop can reach the Mac's localhost), and `AOS_CPUS` caps usage.
 * Dropped capabilities, read-only roots and secret-files instead of `-e` need Sandcastle
 * support first and stay under "Deliberately skipped" in the README until then.
 */
export interface SandboxTuning {
  readonly network?: string | readonly string[];
  readonly cpus?: number;
}

export function sandboxTuning(env: NodeJS.ProcessEnv = process.env): SandboxTuning {
  const tuning: { network?: string | readonly string[]; cpus?: number } = {};
  const network = env.AOS_NETWORK?.trim();
  if (network) {
    const networks = network
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean);
    if (networks.length === 0) throw new AosError(`AOS_NETWORK is blank. Set it to a Docker network, or unset it.`);
    tuning.network = networks.length === 1 ? networks[0] : networks;
  }
  const cpus = env.AOS_CPUS?.trim();
  if (cpus) {
    const value = Number(cpus);
    if (!Number.isFinite(value) || value <= 0) throw new AosError(`AOS_CPUS must be a positive number, got "${env.AOS_CPUS}".`);
    tuning.cpus = value;
  }
  return tuning;
}

/** One-line summary for `aos doctor`, or undefined when tuning is entirely default. */
export function describeTuning(tuning: SandboxTuning): string | undefined {
  const parts: string[] = [];
  if (tuning.network !== undefined) parts.push(`network ${(Array.isArray(tuning.network) ? tuning.network : [tuning.network]).join(",")}`);
  if (tuning.cpus !== undefined) parts.push(`cpus ${tuning.cpus}`);
  return parts.length > 0 ? parts.join("; ") : undefined;
}
