# TODO

Work that is understood but not built yet. The grouped landing review and the `includeIf` guard are listed under "Deferred work" in [docs/security.md](docs/security.md).

## Per-agent self-update opt-outs inside containers

Done: `aos image update` checks the pinned agent CLIs, shows the diff and rebuilds on confirmation, and
the image sets `DISABLE_AUTOUPDATER=1` (Claude Code's documented opt-out) so a pinned install stays pinned.

Remaining: verify and add the equivalent opt-outs for Codex, OpenCode and Pi, if they offer any, instead
of guessing at undocumented variables.
