import { chmodSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { AosError } from "./errors.ts";

/** Writes a mode 0600 file through a sibling staging file and a rename, so a reader never sees a partial file. */
export function writePrivateFileAtomic(path: string, content: string): void {
  const staging = `${path}.aos-${process.pid}.tmp`;
  writeFileSync(staging, content, { mode: 0o600 });
  renameSync(staging, path);
}

export function assertPrivate(path: string, mode: number): void {
  const actual = statSync(path).mode & 0o777;
  if ((actual & 0o077) !== 0) {
    throw new AosError(
      `${path} is readable by other users (mode ${actual.toString(8)}). Run: chmod ${mode.toString(8)} ${path}`,
    );
  }
}

export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}
