import { spawnSync } from "node:child_process";
import { AosError } from "./errors.ts";

/**
 * Branch protection for agent write access: the aos GitHub App's token carries contents write,
 * which GitHub does not separate from force pushes and branch deletion. The App itself has no
 * administration permission, so the ruleset is created with the host user's own `gh` auth
 * (which can administer their repositories), one repository at a time.
 */
export interface RepoSlug {
  readonly owner: string;
  readonly name: string;
}

export function parseRepoSlug(value: string): RepoSlug {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(value.trim());
  if (!match?.[1] || !match?.[2]) throw new AosError(`Expected "<owner>/<repo>", got "${value}".`);
  return { owner: match[1], name: match[2] };
}

/** Ruleset payload: all branches, deletions restricted, force pushes blocked. Nothing else touched. */
export function protectionRuleset(): Record<string, unknown> {
  return {
    name: "aos",
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~ALL"], exclude: [] } },
    rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
    bypass_actors: [],
  };
}

/** Creates the ruleset via the host's `gh` (the user's own admin-capable auth). */
export function applyProtectionRuleset(slug: RepoSlug, dryRun = false): void {
  const endpoint = `repos/${slug.owner}/${slug.name}/rulesets`;
  const payload = JSON.stringify(protectionRuleset());
  if (dryRun) {
    console.log(`gh api --method POST ${endpoint} --input - <<'JSON'\n${payload}\nJSON`);
    return;
  }
  const result = spawnSync("gh", ["api", "--method", "POST", endpoint, "--input", "-"], {
    input: payload,
    encoding: "utf8",
    timeout: 20_000,
  });
  if (result.error) throw new AosError(`gh api failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new AosError(`gh api ${endpoint} failed: ${result.stderr.trim() || result.stdout.trim() || "unknown error"}`);
  }
}
