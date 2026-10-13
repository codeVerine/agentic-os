import { join } from "node:path";
import { readTextFileInside, withFileLock, writePrivateFileAtomic } from "./fsutil.ts";

/**
 * Appends the entry Codex writes itself when its "Trust this folder?" prompt is
 * accepted, so a new project starts without that prompt. Codex only consults the
 * saved entry; a `-c` override does not skip the prompt from a subdirectory.
 * A config.toml that already mentions the path is left alone.
 * The read, update and write run under one lock, so launches that start together keep each other's entries.
 */
export async function trustCodexProject(codexHome: string, sandboxProjectRoot: string): Promise<void> {
  const path = join(codexHome, "config.toml");
  const key = JSON.stringify(sandboxProjectRoot);
  await withFileLock(`${path}.lock`, async () => {
    const current = readTextFileInside(codexHome, path) ?? "";
    if (current.includes(key)) return;
    const separator = current === "" || current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
    writePrivateFileAtomic(path, `${current}${separator}[projects.${key}]\ntrust_level = "trusted"\n`);
  });
}
