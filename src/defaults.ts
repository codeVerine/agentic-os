import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AosError } from "./errors.ts";

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

/** Settings aos fills into one JSON file of an agent's login directory when the user has not set them. */
export interface DefaultsFile {
  /** Path relative to secrets/<agent>/. */
  readonly file: string;
  readonly values: JsonObject;
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Adds the keys of `defaults` that `existing` lacks, recursing into objects that
 * both sides have. Keys the user already set, whatever their value, are kept.
 */
export function fillMissing(existing: JsonObject, defaults: JsonObject): { merged: JsonObject; changed: boolean } {
  const merged: JsonObject = { ...existing };
  let changed = false;
  for (const [key, wanted] of Object.entries(defaults)) {
    const current = existing[key];
    if (current === undefined) {
      merged[key] = wanted;
      changed = true;
    } else if (isObject(current) && isObject(wanted)) {
      const inner = fillMissing(current, wanted);
      merged[key] = inner.merged;
      changed ||= inner.changed;
    }
  }
  return { merged, changed };
}

export function applyDefaults(agentDir: string, defaults: DefaultsFile): void {
  const path = join(agentDir, defaults.file);
  let existing: JsonObject = {};
  if (existsSync(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new AosError(`${path} is not valid JSON (${(error as Error).message}). Fix or remove it, then run again.`);
    }
    if (!isObject(parsed as JsonValue)) throw new AosError(`${path} must hold a JSON object.`);
    existing = parsed as JsonObject;
  }
  const { merged, changed } = fillMissing(existing, defaults.values);
  if (!changed) return;
  const staging = `${path}.aos-${process.pid}.tmp`;
  writeFileSync(staging, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  renameSync(staging, path);
}
