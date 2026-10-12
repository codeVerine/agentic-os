import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writePrivateFileAtomic } from "./fsutil.ts";

/**
 * Appends the entry Codex writes itself when its "Trust this folder?" prompt is
 * accepted, so a new project starts without that prompt. Codex only consults the
 * saved entry; a `-c` override does not skip the prompt from a subdirectory.
 * A config.toml that already mentions the path is left alone.
 */
export function trustCodexProject(codexHome: string, sandboxProjectRoot: string): void {
  const path = join(codexHome, "config.toml");
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const key = JSON.stringify(sandboxProjectRoot);
  if (current.includes(key)) return;
  const separator = current === "" || current.endsWith("\n\n") ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  writePrivateFileAtomic(path, `${current}${separator}[projects.${key}]\ntrust_level = "trusted"\n`);
}
