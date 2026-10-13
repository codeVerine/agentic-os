# TODO

Work that is understood but not built yet. The git guard is parked in [docs/security.md](docs/security.md).

## Update the image's agent CLIs: `aos image update`

**Problem.** The agent CLI versions (`claude-code`, `codex`, `opencode` and `pi`) are pinned in
`docker/Dockerfile`. Moving to a newer version means editing the Dockerfile by hand and running
`aos image build`, with no view of what changed. Inside a container the agents also run their own
self-update checks, which work against an image whose versions are pinned on purpose.

**Planned fix.** An `aos image update` command that:

- checks for a newer version of each pinned agent CLI;
- shows what would change, and rebuilds the image only after the user confirms;
- disables the agents' own self-update checks inside containers.
