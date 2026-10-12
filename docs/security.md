# Security: git guard and open git gaps

Status: **TODO, not implemented.** This document records what aos protects today, the gaps that remain, and a
parked design for closing them. Nothing described under "Proposed design" exists in the code yet.

## Contents

- [Current protections and their limits](#current-protections-and-their-limits)
- [Live gap: host git still runs planted drivers](#live-gap-host-git-still-runs-planted-drivers)
- [Threat inventory](#threat-inventory)
- [Proposed design: prevent, detect, approve](#proposed-design-prevent-detect-approve)
- [Open problems: projects that use hook managers](#open-problems-projects-that-use-hook-managers)
- [Decisions D1 to D5](#decisions-d1-to-d5)
- [Unverified items and risks](#unverified-items-and-risks)

## Current protections and their limits

What an agent container can write today:

| Mode | Writable from the container |
|---|---|
| Worktree (default `aos <agent>`) | The leased worktree folder, the worktree's own `.git` file at its host path, and the **whole shared git directory** of the main repository at its host path. |
| `--here` | The whole project folder including the `.git` directory, reachable at three container paths: its host path, `/home/agent/workspace/.git` and `/home/agent/projects/<name>/.git`. |

What aos does about it:

- Every host git call aos makes itself runs through `hookSafeGitEnv` (`src/hostenv.ts`), which sets
  `core.hooksPath=/dev/null` and `core.fsmonitor=false`. This stops hooks and fsmonitor from running.
- Nothing else. No container mount is read-only, and aos does not compare the git directory against an
  approved state at any point.

Limits:

- Your own git commands, editor integrations (VS Code, Cursor and JetBrains run `git status` continuously and
  can auto-fetch), shell prompts, `gh` and `pre-commit` do not use that protection.
- The protection does not cover filter drivers, merge drivers or `gpg.program` (next section).
- Because the git directory is shared, one agent's planted hook also runs inside other agents' containers when
  they commit, with that container's API keys in its environment.

Safe practice until the guard exists is in the README's ["Security"](../README.md#security) section.

## Live gap: host git still runs planted drivers

**Do not run `aos worktree list` or `aos worktree merge` in a repository you suspect an agent tampered with.
Inspect `.git/config` and `.git/info/attributes` first.**

`aos worktree` commands run host git, and git has no environment switch that disables every filter or merge
driver by name. In a lab, an agent container with the worktree mount shape planted a clean/smudge filter and a
merge driver (both bound to all files through `info/attributes`), a `gpg.program` with `commit.gpgSign=true`,
a `core.fsmonitor` command and six hook scripts in the shared git directory. Each planted command only
created a marker file on the host. Then the real aos CLI ran on the host, from the main checkout:

| Host command | Markers created on the Mac |
|---|---|
| `aos worktree list` | `FILTER_CLEAN` |
| `aos worktree merge T1` | `FILTER_CLEAN GPG_PROGRAM MERGE_DRIVER` (the merge then failed with `error: gpg failed to sign the data`) |
| plain `git status --porcelain` (what a prompt or editor runs) | `FSMONITOR` |

No hook marker fired through aos, so `hookSafeGitEnv` does what it claims. It is just not a complete
baseline:

- `isWorktreeClean` runs `git status --porcelain` in every worktree (`src/worktree.ts`), which runs clean
  filters.
- `mergeLocally` runs `git merge --no-edit` in the main checkout (`src/worktree.ts`), which runs merge
  drivers, filters and commit signing.
- `checkoutNewBranch` and treehouse's own lease checkout write files, which runs smudge filters. Not
  lab-tested; same mechanism.

More `GIT_CONFIG_*` overrides are not a robust fix. The fix in the proposed design is to refuse to run host
git in a repository whose git configuration is not the approved one.

## Threat inventory

"Shared" means one write from any agent session reaches the main checkout and every other worktree of that
repository, because they all use the same git common dir. There is no per-worktree hooks directory.

| # | What | Where it lives | Shared across worktrees | What on the Mac runs it |
|---|---|---|---|---|
| A | Hook scripts (all hook names) | `<common>/hooks/*` | Yes | `git commit/checkout/merge/push`, `gh`, editors that commit |
| A2 | Hooks directory moved with `core.hooksPath` | A config key; can point into a working tree (husky uses `.husky/_`) | Key shared; target can be per-worktree files | Same as A |
| B | Exec-capable repo config keys | `<common>/config` | Yes | See key list below |
| C | Per-worktree config, enabled by `extensions.worktreeConfig` | `<common>/config.worktree`, `<common>/worktrees/<id>/config.worktree` | Per worktree, but any one container can write all of them | Same as B, in that worktree |
| D | Attribute bindings that attach a filter, diff or merge driver to files | `<common>/info/attributes` (shared); `.gitattributes` (per branch) | `info/attributes`: yes | `status`, `checkout`, `diff`, `merge`, `add` |
| E | Redirect files that make host git read a different repository's config | The worktree's `.git` file; `<common>/worktrees/<id>/commondir` and `gitdir`; in `--here` mode the `.git` directory | Own `.git` file: that worktree only. `worktrees/<id>/*` of every worktree is writable from any container | Any git run with its cwd inside that worktree, including `aos worktree list` |
| E2 | Nested repositories left in the working tree (an untracked `sub/.git`, or a bare-repository-shaped directory) | Working tree files | Per worktree | Any git run with its cwd inside that subdirectory |
| F | Hook-manager config files read by an already-installed hook shim | Tracked files: `.pre-commit-config.yaml`, `.husky/*`, `lefthook.yml` and variants | Per branch, until merged | Your next `git commit` in that worktree, or in main after `aos worktree merge` |
| G | Integrity only: moved branches (including `main`), `refs/replace/*`, `info/grafts`, `objects/info/alternates`, main's `HEAD` and `index`, `info/exclude` | `<common>/` | Yes | Nothing runs, but review can be misled |

Exec-capable config keys (categories B and C), grouped by what triggers them:

- Every routine command: `core.fsmonitor`, `core.hooksPath`, `filter.<driver>.clean|smudge|process`.
- Merge and diff: `merge.<driver>.driver`, `diff.external`, `diff.<driver>.command`,
  `diff.<driver>.textconv`, `difftool.<tool>.cmd`, `mergetool.<tool>.cmd`, `interactive.diffFilter`.
- Commits and tags: `gpg.program`, `gpg.<format>.program`, `gpg.ssh.defaultKeyCommand` together with
  `commit.gpgSign` or `tag.gpgSign`; `trailer.<token>.cmd`.
- Network (fetch, push, `gh`, editor auto-fetch): `core.sshCommand`, `core.gitProxy`, `core.askPass`,
  `credential.helper` and `credential.<url>.helper`, `remote.<name>.uploadpack|receivepack|vcs`,
  `protocol.<name>.allow` and `protocol.allow`, `url.<base>.insteadOf|pushInsteadOf`, and remote URLs
  themselves (where pushes go).
- Interactive use: `core.pager`, `pager.<command>`, `core.editor`, `sequence.editor`, `alias.*`,
  `web.browser`, `browser.<tool>.cmd`, `sendemail.smtpServer`.
- Submodules: `submodule.<name>.update` (shell form; honored from `.git/config`, not from `.gitmodules`).
- Indirection: `include.path` and `includeIf.<condition>.path` (the target can be in a working tree),
  `core.worktree`, `core.attributesFile`.

The global `~/.gitconfig` is not mounted into containers, so it is not reachable.

## Proposed design: prevent, detect, approve

Not implemented. Three parts that complement each other.

### 1. Prevent: read-only overlays in every agent container

Mount the files that make the Mac run programs read-only, at every container path where they are reachable.
Sandcastle's `MountConfig` supports `readonly: true`, and user mounts are appended after Sandcastle's own.
Every host path must exist before mounting, so aos must create an empty file first where one is missing.

| Path | Worktree mode | `--here` mode |
|---|---|---|
| `<common>/config` | host path | host path and both `.git/config` aliases |
| `<common>/hooks/` | host path | same three |
| `<common>/info/attributes` (create empty if missing) | host path | same three |
| `<common>/worktrees/`, with the agent's own `worktrees/<id>/` mounted back read-write and its `commondir` and `gitdir` read-only on top | host path | same three |
| The worktree's `.git` file | host path and both container aliases | not applicable |

Lab result for this mount shape:

- Still works: `commit`, `switch -c`, `switch`, `branch -D` (prints `could not write config file ... Device or
  resource busy` but deletes the branch), `stash`, `tag`, `rebase`, `merge`, `worktree list`, `log`, `gc`.
- Refused: writes into `hooks/`, `info/`, other worktrees' `commondir`, the agent's own `commondir`, the `.git`
  file at both container paths, and moving `config`.
- Cost: repo-local `git config` writes fail (`git config user.email` exits 4; `branch -u` and `--track` print
  an error and skip tracking). Sandcastle writes identity to the container's global config, which stays
  writable, so commits still have an author.
- `<common>/config.worktree` stays creatable but is inert, because enabling it needs
  `extensions.worktreeConfig` in the read-only `config`.
- Mounting all of `worktrees/` read-only also covers worktrees leased after the container started. Its cost is
  that an explicit `git gc` fails in the agent.

### 2. Detect and quarantine

Keep one approved baseline per repository in aos state, outside every container mount (not under
`state/run`). Each item records path, file mode and sha256; config items are compared as key/value sets.

Tracked set:

- Every file in `<common>/hooks/` except `*.sample`, and every file in the `core.hooksPath` directory when
  set.
- Config: `<common>/config`, `<common>/config.worktree`, every `<common>/worktrees/<id>/config.worktree` and
  every file named by `include.path` or `includeIf.*.path`. Parse with
  `git config --file <path> --list --no-includes` (parsing never runs anything) and follow includes in the
  guard.
- Allowlist, not denylist: flag every key change except a short benign list (`branch.<name>.remote|merge|
  rebase|description`, `core.repositoryformatversion|filemode|logallrefupdates|ignorecase|precomposeunicode|
  symlinks`, `user.name|email`, `remote.<name>.fetch`). A key git adds in a future version is flagged by
  default.
- `<common>/info/attributes` and `<common>/info/exclude`.
- Redirect files: each registered worktree's `.git` file and every `<common>/worktrees/<id>/commondir` and
  `gitdir`.
- Cheap integrity markers: `refs/replace/` non-empty, `info/grafts`, `objects/info/alternates`.

When the guard runs:

| Moment | On an unapproved difference |
|---|---|
| First use of a repository | No baseline yet. If nothing exec-capable exists, record it silently. Otherwise show what exists and ask once. Repositories used in `--here` mode have been agent-writable, so this doubles as an audit. |
| Launch, before the lease or any host git beyond discovery | No agent can have written the protected set, so a difference is your own change. On a TTY ask "adopt as approved?". Otherwise refuse to launch. |
| Session end (the existing cleanup that also runs on SIGHUP, SIGINT and SIGTERM) | Quarantine: move each changed hook and attributes file to the guard state directory, restore the approved copy, undo each flagged config key with `git config --file`. Print a short report. |
| Before every `aos worktree` subcommand | Refuse with "run `aos guard review`" while any unapproved change is live. Quarantined items do not block. |
| `aos worktree merge <id>` | List changed hook-manager files in the branch diff (`.pre-commit-config.yaml`, `.husky/`, `lefthook*.yml`, `.gitattributes`, `.gitmodules`, `.lfsconfig`, anything under an in-tree `core.hooksPath`) and require `--approve-hooks` or a TTY yes. Scan the branch for nested `.git` entries. |
| `aos doctor` | Show the guard state of the current repository. |

This gate before host git is what closes the live gap above.

### 3. Approve by hand

```
aos guard status            Guard state for this repository: clean, live unapproved changes, or quarantined items
aos guard review [<n>]      Show each change: full new content of hooks and attributes (control characters
                            escaped), config key/value before and after, redirect file before and after
aos guard approve <n>|--all Restore the quarantined item (or keep the live one), record it in the baseline and log
aos guard reject <n>|--all  Delete the quarantined item (or undo the live one) and keep the baseline as is
```

Approval is recorded in `baseline.json` (approved items with mode and sha256, plus copies of approved hook
and attributes files so quarantine can restore them) and an append-only `approvals.log` (time, item, old and
new hash), under a state directory that is never mounted into a container.

### What stays uncovered

- Integrity of refs and objects (G): an agent can still move `main` or rewrite history in the shared object
  store. A per-session clone instead of a shared worktree is the root fix, if that ever matters.
- Tracked file content in general (scripts, `package.json`, `.envrc`): the same review as any pull request.
- Committing on the Mac inside an agent worktree before merging runs that branch's hook-manager config. The
  session-end report should list changed hook-manager files so this is visible.
- Libgit2-based git clients ignore git's own config, so none of this affects them, in either direction.

### Alternatives considered

| Mechanism | Why not alone |
|---|---|
| Snapshot at launch, compare at session end | Misses the in-session window: a planted hook is live on the Mac for the whole session. A per-session snapshot also absorbs another session's unapproved change, because all worktrees share one git dir. Skipped by SIGKILL or power loss. |
| Same plus a live `fs.watch` | Shrinks the window to about a second (host FSEvents fire for container writes through a Docker Desktop bind mount), but a race remains and the TUI owns the terminal, so aos cannot tell you mid-session. |
| Host `git` wrapper on PATH | Covers terminal git, `gh` and `pre-commit`, but misses GUI apps, IDEs with an explicit git path and absolute `/usr/bin/git`. A bug blocks all git on the Mac. |
| macOS `chflags uchg` during sessions | Blocks your own `git config` writes too, and flags survive a crash. |
| Per-session clone | Root fix, removes the shared git dir. Not chosen; aos uses worktrees. |

### Build order

Each step ships on its own and adds protection.

1. Read-only overlays at launch (a pure function returning the mount list for all aliases). Closes the
   in-session window and cross-container spread.
2. Guard core: `snapshot` and `compare` as pure functions over fs reads and `git config --file --list
   --no-includes`.
3. Baseline store and `aos guard status|review|approve|reject`.
4. Gate: verify at launch and at the top of every `aos worktree` subcommand. Closes the live gap.
5. Session-end check and quarantine, synchronous because it also runs from the exit handler.
6. Merge gate for hook-manager files and nested repositories, plus `aos doctor` reporting.
7. README: replace the warning with the guard's guarantees and limits.

## Open problems: projects that use hook managers

Most projects an open-source user works on will have pre-commit hooks, husky or lefthook configured. The
design above was surveyed against repositories with no hooks at all, so a strict guard costs nothing there but
has real friction for these projects. None of the following is solved.

- **Hooks run inside the container.** Commits in the container still run the project's hooks. `pre-commit`
  needs its runner installed in the image, or every commit in such a project fails.
- **Husky hooks live in the working tree.** Husky keeps hooks in `.husky/` and points `core.hooksPath` at it.
  That folder is agent-writable by design, so a read-only `.git` does not protect it, and the hooks then run
  on the Mac at your next commit there. The guard would need to protect that folder too.
- **Legitimate edits create approval friction.** Agents legitimately edit `.pre-commit-config.yaml` or
  `.husky/*`. Asking for approval on every such change is friction in hook-heavy projects.
- **Husky's install step writes git config.** `npm install` runs husky's `prepare` script, which writes
  `core.hooksPath`. A read-only `config` would block that write. Whether `npm install` then fails is untested.

A possible answer: recognize husky, pre-commit and lefthook; protect their real hook folders; and offer a
strict default mode plus a lighter trust-hook-managers mode, chosen per project.

## Decisions D1 to D5

None of these are decided. The recommendation is what the design above assumes.

| # | Question | Options | Recommendation |
|---|---|---|---|
| D1 | Prevent changes in containers, or only detect them? | (a) Read-only overlays plus detection. (b) Detection only, with a live watch. (c) Detection at session end only. | (a). Only (a) stops a planted hook from running on the Mac or in other agents' containers while a session is open. Cost: agents cannot write repo-local git config. |
| D2 | What happens to an unapproved change the guard finds? | (a) Quarantine automatically, approve to restore. (b) Leave it, warn and block aos commands. (c) Warn only. | (a). The Mac is safe the moment aos sees the change, and approval is one command. |
| D3 | Repositories aos already used, which have been agent-writable | (a) First use: record silently when nothing exec-capable exists, otherwise show and ask. (b) Always show and ask. (c) Trust silently. | (a). Asks only when there is something real to look at. |
| D4 | How wide should the guard look? | (a) Hooks and exec config only (A to E). (b) Also hook-manager files at merge time (F). (c) Also integrity markers (G). | (b) plus the cheap part of (c). F matters as soon as a repository adopts pre-commit or husky; the three G markers cost a `stat` each. |
| D5 | Install a `git` wrapper on the PATH? | (a) No. (b) Opt-in later. (c) Yes. | (a). With D1(a) nothing reaches the protected files during a session, and a wrapper adds a global failure point while missing GUI tools. |

The hook-manager problems above add a sixth question that is also open: strict mode only, or strict plus a
trust-hook-managers mode.

## Unverified items and risks

- Not lab-tested: smudge filters firing during treehouse's own lease checkout, background auto-gc failing
  quietly under the read-only `worktrees/` mount, and husky's `prepare` behavior when it cannot set
  `core.hooksPath` inside a container.
- A single-file bind mount pins the file the container sees. If git on the Mac rewrites `.git/config` during a
  session (it writes through a lock file and rename), the container keeps reading the old copy until the next
  launch. The Mac side is unaffected.
- Docker orders nested mounts by destination path depth, which the lab relied on. Another container runtime
  may not.
- The exec-capable key list is broad but not provably complete; the allowlist approach is what makes an
  unknown key safe.
- The survey that suggested low false-positive cost covered a handful of repositories with no hook managers.
  It says little about projects that use them.
