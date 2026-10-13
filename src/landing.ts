import { git } from "./git.ts";

export interface LandingRisk {
  readonly path: string;
  readonly reason: string;
}

const BASENAME_RULES: Readonly<Record<string, string>> = {
  "lefthook.yml": "hook-manager config (runs its commands on the Mac)",
  "lefthook.yaml": "hook-manager config (runs its commands on the Mac)",
  ".lefthook.yml": "hook-manager config (runs its commands on the Mac)",
  ".lefthook.yaml": "hook-manager config (runs its commands on the Mac)",
  ".lefthook.json": "hook-manager config (runs its commands on the Mac)",
  ".lefthook.toml": "hook-manager config (runs its commands on the Mac)",
  ".pre-commit-config.yaml": "hook-manager config (runs its hooks on the Mac)",
  ".gitattributes": "binds filters/diffs/drivers to file content (runs approved programs on agent files)",
  "package.json": "install scripts (review the \"scripts\" section before install)",
};

const DIR_PREFIX_RULES: ReadonlyArray<readonly [string, string]> = [
  [".husky/", "hook script (runs on the Mac)"],
  [".githooks/", "hook script (runs on the Mac)"],
  [".lefthook/", "hook-manager config (runs its commands on the Mac)"],
];

/** Why `path` (repo-relative, POSIX) will execute on the Mac after merge, or undefined when inert. */
export function classifyLandingPath(path: string): string | undefined {
  const base = path.split("/").pop() ?? path;
  const direct = BASENAME_RULES[base];
  if (direct) return direct;
  for (const [prefix, reason] of DIR_PREFIX_RULES) {
    if (path === prefix.slice(0, -1) || path.startsWith(prefix)) return reason;
  }
  return undefined;
}

/** Files changed on `branch` since it diverged from HEAD, with their landing risk. */
export function landingReview(mainRoot: string, branch: string): { readonly changed: number; readonly risks: readonly LandingRisk[] } {
  const base = git(mainRoot, "merge-base", "HEAD", branch).split("\n")[0]?.trim() ?? "";
  if (!base) return { changed: 0, risks: [] };
  const names = git(mainRoot, "diff", "--name-only", "-z", base, branch)
    .split("\0")
    .map((n) => n.trim())
    .filter(Boolean);
  const risks: LandingRisk[] = [];
  for (const path of names) {
    const reason = classifyLandingPath(path);
    if (reason) risks.push({ path, reason });
  }
  return { changed: names.length, risks };
}

/** One grouped review block for `merge`, printed before the merge runs. Empty when nothing risky changed. */
export function formatLandingReview(branch: string, review: { readonly changed: number; readonly risks: readonly LandingRisk[] }): string {
  if (review.risks.length === 0) return "";
  const lines = [
    `aos: landing review for ${branch} (${review.changed} file${review.changed === 1 ? "" : "s"} changed):`,
    "aos: these files will run on the Mac after merge — review them before pushing or installing:",
  ];
  for (const risk of review.risks) lines.push(`aos:   ${risk.path} — ${risk.reason}`);
  return lines.join("\n");
}
