import { closeSync, constants as fsConstants, existsSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { spawnGit } from "./git.ts";

const MAX_HOOK_BYTES = 64 * 1024;
/** Directories only a Mac has, so an interpreter or tool path under one cannot exist in the image. */
const MAC_ONLY_PREFIXES = ["/opt/homebrew/", "/opt/local/", "/Users/", "/Applications/", "/Library/", "/private/", "/System/"];

export interface HookRunnerContext {
  readonly commonDir: string;
  readonly worktreePath: string;
  /** The session's hooks directory, copied from the repository's approved one. */
  readonly sessionHooksDir: string;
}

function readText(path: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return undefined;
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_HOOK_BYTES));
    return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function hookFiles(dir: string): { name: string; text: string }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: { name: string; text: string }[] = [];
  for (const name of names) {
    const text = name.endsWith(".sample") ? undefined : readText(join(dir, name));
    if (text !== undefined) files.push({ name, text });
  }
  return files;
}

/**
 * What would make the repository's own git hooks fail inside the aos container, each with the action that fixes
 * it. pre-commit ships in the aos image, so only runners and paths the image cannot supply are reported:
 * lefthook without a `node_modules` copy, husky's generated hooks directory before `npm install`, interpreters
 * under Mac-only directories, and a `core.hooksPath` outside the project.
 */
export function hookRunnerProblems(context: HookRunnerContext): string[] {
  const problems: string[] = [];
  const configured = spawnGit(["config", "--file", join(context.commonDir, "config"), "--get", "core.hooksPath"]);
  const hooksPath = configured.status === 0 ? configured.stdout.trim() : "";
  const files = hookFiles(context.sessionHooksDir);

  if (hooksPath !== "") {
    const dir = resolve(context.worktreePath, hooksPath);
    const inside = dir === context.worktreePath || dir.startsWith(context.worktreePath + sep);
    if (!inside) {
      problems.push(
        `core.hooksPath is ${hooksPath}, outside the project, which the container cannot see, so commits in the session run none of those hooks. Point it at a directory inside the project (for example .githooks).`,
      );
    } else if (!existsSync(dir)) {
      const husky = relative(context.worktreePath, dir).split(sep)[0] === ".husky";
      problems.push(
        husky
          ? `core.hooksPath is ${hooksPath}, which husky creates during \`npm install\` (its prepare script). Run your package install in the session first, or commits run no hooks.`
          : `core.hooksPath is ${hooksPath}, which does not exist in this worktree, so commits in the session run no hooks.`,
      );
    } else {
      files.push(...hookFiles(dir));
    }
  }

  if (files.some((file) => /\blefthook\b/.test(file.text)) && !existsSync(join(context.worktreePath, "node_modules", ".bin", "lefthook"))) {
    problems.push(
      "this project's git hooks run lefthook, which the aos image does not include and node_modules does not have yet. Run your package install in the session (for example `npm install`) before committing, or commits fail.",
    );
  }
  for (const file of files) {
    const interpreter = /^#!\s*(\S+)/.exec(file.text)?.[1] ?? "";
    if (MAC_ONLY_PREFIXES.some((prefix) => interpreter.startsWith(prefix))) {
      problems.push(
        `hook ${file.name} starts with ${interpreter}, a path that only exists on the Mac, so it fails in the container. Use \`#!/usr/bin/env <interpreter>\` instead.`,
      );
    }
  }
  return problems;
}
