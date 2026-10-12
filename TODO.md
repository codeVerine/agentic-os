# TODO

Work that is understood but not built yet. The git guard is parked in [docs/security.md](docs/security.md).

## Git "dubious ownership" inside containers

**Problem.** Inside a container, git can refuse the repository with `detected dubious ownership in repository`,
so `git status`, `git commit` and friends fail until the user works around it by hand.

**Cause.** Git only trusts a repository whose files are owned by the current user, unless the path is listed in
`safe.directory`. Sandcastle adds only `/home/agent/workspace` to `safe.directory`. aos runs the agent from
`/home/agent/projects/<name>-<hash>` (`src/launch.ts`), which is not covered. In a worktree session the shared
git common directory is mounted at its host path, which is not covered either.

**Planned fix.** At launch, add exact `safe.directory` entries for the agent's project path and, in a worktree
session, the shared git common directory's host path. Never `*`, so a path an agent can reach is not trusted
unless aos mounted it for that launch.

## Update the image's agent CLIs: `aos image update`

**Problem.** The agent CLI versions (`claude-code`, `codex`, `opencode` and `pi`) are pinned in
`docker/Dockerfile`. Moving to a newer version means editing the Dockerfile by hand and running
`aos image build`, with no view of what changed. Inside a container the agents also run their own
self-update checks, which work against an image whose versions are pinned on purpose.

**Planned fix.** An `aos image update` command that:

- checks for a newer version of each pinned agent CLI;
- shows what would change, and rebuilds the image only after the user confirms;
- disables the agents' own self-update checks inside containers.
