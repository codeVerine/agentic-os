import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { AosError } from "./errors.ts";

export interface ApprovalIo {
  readonly interactive: boolean;
  readonly ask: (question: string) => Promise<string>;
}

export function terminalApprovalIo(): ApprovalIo {
  return {
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    ask: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };
}

export function isApproved(file: string, root: string): boolean {
  return readApproved(file).includes(root);
}

/**
 * Makes sure the folder that is about to be mounted read-write into the container is one the user
 * approved. Approval is per exact path: approving a folder never approves its parents or children.
 */
export async function ensureApproved(file: string, root: string, io: ApprovalIo): Promise<void> {
  if (isApproved(file, root)) return;
  if (!io.interactive) {
    throw new AosError(
      `${root} has not been approved for aos and there is no terminal to ask on. Run aos from a terminal in that folder once to approve it.`,
    );
  }
  const answer = await io.ask(`aos will mount ${root} read-write into the container.\nApprove this folder and start? [y/N] `);
  if (!/^y(es)?$/i.test(answer.trim())) throw new AosError(`${root} was not approved. Nothing was started.`);
  approve(file, root);
}

function approve(file: string, root: string): void {
  const approved = readApproved(file);
  if (approved.includes(root)) return;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const staging = `${file}.aos-${process.pid}.tmp`;
  writeFileSync(staging, `${[...approved, root].join("\n")}\n`, { mode: 0o600 });
  renameSync(staging, file);
}

function readApproved(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((line) => line !== "");
}
