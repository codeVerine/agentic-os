# Security: host execution through git

This document records how a worktree session keeps an agent's git changes from running code on your Mac, what
that protection does not cover, and what is deliberately left for later. The threat it is about is a **turned
agent**: one that was prompt-injected through an issue, a web page, a dependency README or tool output, and
runs with full autonomy inside the container. The container is the boundary. Behind it on your Mac are your SSH
keys, `~/AgenticOS/secrets` (every agent login and the GitHub App key, which can mint tokens for every
repository the App is installed on) and your other repositories. A malicious repository you chose to work in is
out of scope: installing its dependencies is your trust decision, with or without aos.

## Contents

- [Summary](#summary)
- [How a worktree session is isolated](#how-a-worktree-session-is-isolated)
- [What the container can and cannot write](#what-the-container-can-and-cannot-write)
- [Hooks and hook managers](#hooks-and-hook-managers)
- [Other protections](#other-protections)
- [What still runs on the Mac](#what-still-runs-on-the-mac)
- [Deferred work](#deferred-work)
- [`--here` is unprotected](#--here-is-unprotected)
- [Not supported](#not-supported)
- [Why not read-only overlays](#why-not-read-only-overlays)
- [Verification](#verification)

## Summary

In worktree mode (`aos <agent>`, the default), what an agent writes into git metadata never reaches your
repository's `.git`:

| Channel | Before | Now |
|---|---|---|
| `.git/config` keys (fsmonitor, filter and merge drivers, `sshCommand`, `uploadpack`, `include.path`) | Writable from the container; ran on your next `git status`, including your editor's | The session has its own config. The repository's is not mounted writable |
| `.git/hooks/*` | Writable; ran on your next commit | The session has its own hooks directory |
| `.git/commondir`, `worktrees/<id>/*` | Writable; redirected your main checkout's git to an agent-made directory | Not mounted writable |
| Branch refs | Writable; moving `feature` to a commit with a changed in-tree hook ran it on your `git checkout feature` | The session has its own refs. The branch comes back by import (below) |
| Objects | Writable; an agent could delete or corrupt history | Read-only |
| `remote.origin.url` retarget (token for another repository) | Next launch minted a GitHub token for whatever origin named | Container cannot write the repository's config, and the repository is pinned at first launch |
| Ignored files in a reused pool slot (`.husky/_` stubs, `node_modules/.bin`) | Carried to whoever leased the slot next, on the Mac | aos has its own treehouse pool, so only agent containers lease those slots |

What is closed is every channel that **never shows up in a diff**. Files that are tracked in the session
branch (`.husky/pre-commit`, `.githooks/*`, `lefthook.yml`, `.pre-commit-config.yaml`, `package.json` scripts)
are part of the branch's normal diff and are covered by your own review before you merge. See [Deferred
work](#deferred-work) for the grouped review that would make them prominent.

## How a worktree session is isolated

```
Mac                                                  Container (aos session)
---                                                  -----------------------
<repo>/.git            approved config/hooks/refs    mounted read-only at /mnt/aos-host-git (the `host` remote)
<repo>/.git/objects    <------ read-only ---------   mounted read-only at its host path (alternates target)
<slot>/                treehouse worktree folder     /home/agent/projects/<name>          read-write
<slot>/.git (file)     gitdir: <repo>/.git/...       /home/agent/projects/<name>/.git     read-only file:
                                                         "gitdir: <session git dir>"
~/AgenticOS/state/gitdirs/<project>/<id>.git         the session git dir, read-write: its own config,
                                                     hooks, info, refs and index; objects/info/alternates
                                                     names the repository's objects
<per-launch empty repo>                              /home/agent/workspace (Sandcastle's own mount)
```

- **The folder stays where treehouse put it, in aos's own pool.** On the Mac its `.git` file still points at
  your repository, so your git, your editor and treehouse see the approved setup and nothing else.
- **The session git directory is made by the host, before any container sees it.** It starts as a copy of your
  approved config, the non-sample files of `hooks/` and `info/`, remote-tracking refs and tags. The session
  branch starts at the commit aos created it from, and the index is `read-tree HEAD` (no filters run).
- **Sandcastle is given an empty per-launch repository as its working directory.** Sandcastle mounts its `cwd`
  and that directory's `.git` read-write and runs its own host git there, so it must never be a project's
  checkout. aos mounts the project folder and the session git dir itself.
- **The branch comes back by import.** About a second after each agent commit, and again when the session
  ends, a throwaway container with no network and the session git dir mounted read-only writes a git bundle.
  The host fetches the bundle with `transfer.fsckObjects=true` and moves the session branch. Host git never
  opens the agent-written session git dir, so a config or hook planted there has nothing to run on.
  If the import cannot run (Docker is down, the machine slept), the commits stay in the session git dir
  and `aos worktree list`, `merge` and `rm` import them.
- **Ownership rule.** The repository's branch is replaced only while it is still at the tip imported last,
  so a rewritten session history imports, and commits you made on the branch from the Mac are never
  discarded. When you moved the branch and the session no longer contains your commits, the session goes to
  `<branch>-<n>` with a message, and later imports of that session continue on that branch.
- **Pull, push and your own local work.** The session's `origin` is your approved `origin` URL, so `git
  fetch`, `pull`, `push` and `gh` behave as before and use the GitHub App token. Your local branches are
  visible as `host/<branch>`: aos runs `git fetch host` once at session start, and the agent can run it again.
  The `host` mount is read-only and cannot carry writes back.
- **Migration.** A worktree created before this change gets a session git dir the next time it is resumed,
  made from the branch's current commit.

## What the container can and cannot write

| Path | Worktree session |
|---|---|
| The leased worktree folder | read-write |
| The worktree's `.git` file | read-only (shadowed by aos's gitfile) |
| The session git dir | read-write |
| The repository's `.git` (config, hooks, refs, `commondir`, `worktrees/`) | not writable: mounted read-only at `/mnt/aos-host-git`, not mounted at its host path |
| The repository's object stores (including chained alternates) | read-only at their host paths |
| aos state, secrets of other agents, `~/AgenticOS/state/*` | not mounted |

## Hooks and hook managers

Hooks and hook configuration stay writable and session-local, and the repository's own hooks run in the
container for the agent's commits, so failures stay visible.

| Situation | Behavior |
|---|---|
| Existing, unchanged hooks | Copied into the session; work with no prompt |
| Husky (`npm install` runs `prepare`) | Writes `core.hooksPath` and its stubs into the session; the Mac's config is untouched |
| pre-commit | `pre-commit` is in the aos image, with a per-project cache mounted at `~/.cache/pre-commit`. `pre-commit install` writes the session's hooks; a Mac-style shim in the copied hooks also works, because it falls back to `pre-commit` on `PATH` |
| Lefthook | `lefthook install` writes the session's hooks; the runner comes from `node_modules` |
| Custom `core.hooksPath` | The approved value is in the session's config, so it works |
| Custom copy-installers | Use `git rev-parse --git-path hooks` and install into the session. A script that writes the literal path `.git/hooks/...` fails, as in any linked worktree |
| Agent edits hooks or related scripts | Normal branch diff; nothing is discarded and nothing prompts |
| Missing runner | One line at launch says what is missing and the setup action (see below) |

At launch aos reads the hooks it copied and the in-tree `core.hooksPath` directory and prints a line for what
the container could not run: lefthook without `node_modules`, husky's generated directory before `npm install`,
an interpreter under a Mac-only path such as `/opt/homebrew`, a `core.hooksPath` outside the project.

## Other protections

- **Dedicated treehouse pool.** aos leases from `~/AgenticOS/state/treehouse` (`treehouse --root`), not your
  default pool. `treehouse return` keeps ignored files, so a shared pool carried agent-written ignored files
  (`.husky/_` stubs) to whoever leased the slot next on the Mac, including other tools. Existing worktrees stay
  in their old pool until removed: the record remembers its root. A plain `treehouse status` shows only your
  default pool; `aos worktree list` shows both.
- **GitHub repository pin.** At a project's first launch aos records which GitHub repository its `origin`
  names, in `~/AgenticOS/state/github-repos/<project>.json`, and later refuses to give an agent a token when
  `origin` names a different one. This applies in both modes. If a repository really moved, delete that file
  and start a new session.
- **Host git hardening (unchanged).** Every host git call aos makes runs with `core.hooksPath=/dev/null` and
  `core.fsmonitor=false`.
- **No fetch on launch.** aos leases with `treehouse get --no-fetch`, so a launch never runs `git fetch origin`
  with the repository's config (the `core.sshCommand`, `core.gitProxy` and `uploadpack` fetch vectors).
  A `treehouse get` you run by hand still fetches.
- **`safe.directory` is exact.** The container's git trusts only the project mount and the session git dir
  (and, baked into the image, the read-only `/mnt/aos-host-git`), never `*`.

## What still runs on the Mac

| # | Channel | Mitigation |
|---|---|---|
| 1 | Content you approved and merged | By design |
| 2 | You run git **inside an agent worktree** on the Mac. Your approved `core.hooksPath=.husky/_` runs the slot's agent-written ignored stub and unreviewed tracked hook files | Run `aos guard install` (pauses hooks/fsmonitor while an `aos/*` branch is checked out), review the branch before running git or `npm` inside the folder, or work from the main checkout |
| 3 | Programs your approved config binds through the branch's `.gitattributes` (for example git-lfs) run on agent-supplied file content during `aos worktree list`, `rm` and the index refresh | Approved programs only. Review `.gitattributes` changes |
| 4 | Nested repositories an agent leaves untracked in its folder (`sub/.git` with its own config), for editors that auto-detect them. aos runs git only at the worktree root | Do not open an agent worktree in an editor you have not reviewed |
| 5 | `index-pack` and fsck parse agent-supplied pack data during import | Same exposure as fetching from any remote; objects are checked |
| 6 | The per-launch anchor repository Sandcastle runs host git in is agent-writable for the length of the session | It is an empty throwaway directory, removed at exit; the commands Sandcastle runs there (`rev-parse`, `config`, `rev-list`) execute no repository-controlled programs |
| 7 | Agent state mounts (`secrets/<agent>`) | Out of scope here; see the file I/O hardening work |

## Deferred work

These were designed and are not built. They are listed so the docs state what is and is not covered.

- **`--here` hook pause.** `--here` now warns on every launch that it runs unprotected; pausing its hooks is not applicable while `--here` itself is unchanged.
- **Network egress control.** Containers use Docker's default bridge network unless `AOS_NETWORK` points them at your own networks; per-session networks and fresh per-session clones are not built.

Built since: the grouped landing review (printed by `aos worktree merge`, see `src/landing.ts`)
and the `includeIf "onbranch:aos/**"` guard (`aos guard install`, see `src/guard.ts`).

## `--here` is unprotected

`--here` is unchanged. The agent runs in your own checkout with read-write access to your real `.git`, so **every
finding in this document applies to `--here` sessions**: config, hooks, `commondir`, refs and objects are all
writable from the container, and an agent's change runs on your Mac on your next git command. The repository
pin (above) is the one protection that applies in both modes.

Use worktree mode for untrusted or free-running agents, and `--here` only when you would be comfortable
running the agent's output on the Mac directly.

## Not supported

- Committing inside submodules from the container. Submodules work read-only through the repository mount.
- A main repository using reftable. The image's git cannot read it, and the session's own refs always use files.
- Writing hooks to the literal path `.git/hooks/...` from a script (see above).
- A main repository's `extensions.worktreeConfig` / `config.worktree` settings are not carried into the session.
- Git LFS (not in the image today).
- If you rewrite history and prune objects a live session still needs, that session breaks; this is rare.

## Why not read-only overlays

An earlier plan mounted `config`, `hooks/`, `info/` and the `.git` file read-only on top of Sandcastle's
read-write mount of the shared git directory. It does not close host execution:

1. Sandcastle mounts the whole shared git directory read-write at its host path, and a second read-only
   mount at the same destination does not win: Docker kept the read-write mount in both orders. The root of the
   git directory stays writable, and git honors a `commondir` file in any git directory. In a lab, with every
   overlay in place, a container wrote `.git/commondir` pointing at an agent-made directory, and the next plain
   `git status` in the main checkout ran an agent `core.fsmonitor` on the Mac.
2. Refs stay shared. A container moved a branch to a commit that changed an in-tree hook, and
   `git checkout <branch>` on the Mac ran it.

The private session git dir gives the container no writable path into the repository's git directory at all,
which makes both moot.

## Verification

The manual end-to-end scenarios (the planted-vector checks, the five hook-manager repositories, pull and push,
resume and history rewrite) and their recorded results are in
[verification/host-exec.md](verification/host-exec.md).
